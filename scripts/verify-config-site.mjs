import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCatalogManifest } from "../packages/config-page/src/catalog-client.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITE_PATH = join(PROJECT_ROOT, "var/config-site");
const REQUIRED_CATALOG_GROUPS = ["search", "places", "services"];
const REMOTE_CONCURRENCY = 16;

function fail(message) {
  throw new Error(`verify:config-site failed: ${message}`);
}

function siteOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("origin must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== "") {
    fail("origin must be an absolute HTTPS URL without credentials, query, or fragment");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else fail(`unsupported site entry: ${relative(root, path)}`);
    }
  }
  visit(root);
  return files.sort();
}

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function verifyLocalSite(sitePath) {
  const root = resolve(sitePath);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`site directory does not exist: ${root}`);
  }
  const indexPath = join(root, "index.html");
  const manifestPath = join(root, "catalog", "manifest.json");
  if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) fail("index.html is missing");
  if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) fail("catalog/manifest.json is missing");

  const manifest = parseJson(manifestPath, "catalog manifest");
  if (!isCatalogManifest(manifest)) fail("catalog manifest does not satisfy the static catalog contract");
  const revisionRoot = join(root, "catalog", manifest.revision);
  if (!statSync(revisionRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`catalog revision directory is missing: ${manifest.revision}`);
  }

  let catalogJsonCount = 0;
  for (const group of REQUIRED_CATALOG_GROUPS) {
    const groupRoot = join(revisionRoot, group);
    if (!statSync(groupRoot, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`current catalog has no ${group} directory`);
    }
    const groupFiles = filesUnder(groupRoot).filter((path) => path.endsWith(".json"));
    if (groupFiles.length === 0) fail(`current catalog has no ${group} JSON`);
    for (const path of groupFiles) {
      const document = parseJson(path, relative(root, path));
      if (document?.schemaVersion !== manifest.schemaVersion || document?.revision !== manifest.revision) {
        fail(`${relative(root, path)} does not match the current schema and revision`);
      }
      catalogJsonCount += 1;
    }
  }

  return {
    root,
    manifest,
    files: filesUnder(root),
    catalogJsonCount,
  };
}

function remoteUrl(origin, root, path) {
  const parts = relative(root, path).split(sep);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`unsafe site path: ${relative(root, path)}`);
  }
  return new URL(parts.map(encodeURIComponent).join("/"), origin);
}

async function verifyServedFiles(local, origin, fetcher) {
  let next = 0;
  async function worker() {
    while (next < local.files.length) {
      const path = local.files[next];
      next += 1;
      const url = remoteUrl(origin, local.root, path);
      let response;
      try {
        response = await fetcher(url, {
          headers: { Accept: "*/*", "Cache-Control": "no-cache" },
          redirect: "error",
        });
      } catch {
        fail(`could not fetch ${url.href}`);
      }
      if (!response.ok) fail(`${url.href} returned HTTP ${response.status}`);
      const expected = readFileSync(path);
      const actual = Buffer.from(await response.arrayBuffer());
      if (!actual.equals(expected)) fail(`served bytes differ for ${url.href}`);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(REMOTE_CONCURRENCY, local.files.length) },
    () => worker(),
  ));
}

export async function verifyConfigSite({
  sitePath = DEFAULT_SITE_PATH,
  origin,
  fetcher = globalThis.fetch,
} = {}) {
  const local = verifyLocalSite(sitePath);
  const parsedOrigin = siteOrigin(origin);
  await verifyServedFiles(local, parsedOrigin, fetcher);
  return {
    origin: parsedOrigin.href,
    revision: local.manifest.revision,
    sourceRevision: local.manifest.sourceRevision,
    fileCount: local.files.length,
    catalogJsonCount: local.catalogJsonCount,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyConfigSite({
      sitePath: process.argv[2] ?? DEFAULT_SITE_PATH,
      origin: process.argv[3] ?? process.env.CONFIG_SITE_ORIGIN,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
