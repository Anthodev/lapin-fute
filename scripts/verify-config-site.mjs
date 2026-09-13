import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCatalogManifest,
  isCatalogSearchPage,
  isCatalogServiceDocument,
  isCatalogServicesPage,
} from "../packages/config-page/src/catalog-client.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITE_PATH = join(PROJECT_ROOT, "var/config-site");
const REQUIRED_CATALOG_GROUPS = ["search", "places", "services"];
const REMOTE_CONCURRENCY = 16;
const REMOTE_TIMEOUT_MS = 30_000;

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

function verifyLocalSite(sitePath, includeCatalog) {
  const root = resolve(sitePath);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`site directory does not exist: ${root}`);
  }
  const indexPath = join(root, "index.html");
  if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) fail("index.html is missing");
  if (!includeCatalog) {
    return {
      root,
      manifest: null,
      files: filesUnder(root),
      catalogJsonCount: 0,
    };
  }

  const manifestPath = join(root, "catalog", "manifest.json");
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
      const catalogPath = relative(revisionRoot, path).split(sep);
      const page = catalogPath.at(-1)?.match(/^([0-9]+)\.json$/u);
      const valid = group === "search"
        ? catalogPath.length === 3 && page !== undefined && page !== null
          && isCatalogSearchPage(document, manifest.revision, Number(page[1]))
        : group === "places"
          ? catalogPath.length === 3 && page !== undefined && page !== null
            && isCatalogServicesPage(document, manifest.revision, catalogPath[1], Number(page[1]))
          : catalogPath.length === 2
            && isCatalogServiceDocument(
              document,
              manifest.revision,
              catalogPath[1].replace(/\.json$/u, ""),
            );
      if (!valid) fail(`${relative(root, path)} does not satisfy the static catalog contract`);
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
      const expected = readFileSync(path);
      try {
        const response = await fetcher(url, {
          headers: { Accept: "*/*", "Cache-Control": "no-cache" },
          redirect: "error",
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!response.ok) fail(`${url.href} returned HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > expected.length) {
          fail(`served response is too large for ${url.href}`);
        }
        if (response.body === null) fail(`served response has no body for ${url.href}`);
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        let finished = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              break;
            }
            bytes += value.byteLength;
            if (bytes > expected.length) fail(`served response is too large for ${url.href}`);
            chunks.push(value);
          }
        } finally {
          if (!finished) await reader.cancel();
          reader.releaseLock();
        }
        const actual = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
        if (!actual.equals(expected)) fail(`served bytes differ for ${url.href}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("verify:config-site failed:")) throw error;
        fail(`could not fetch or validate ${url.href}`);
      }
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
  includeCatalog = true,
} = {}) {
  const local = verifyLocalSite(sitePath, includeCatalog);
  const parsedOrigin = siteOrigin(origin);
  await verifyServedFiles(local, parsedOrigin, fetcher);
  return {
    origin: parsedOrigin.href,
    revision: local.manifest?.revision ?? null,
    sourceRevision: local.manifest?.sourceRevision ?? null,
    fileCount: local.files.length,
    catalogJsonCount: local.catalogJsonCount,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    const pageOnly = arguments_.includes("--page-only");
    const positional = arguments_.filter((argument) => argument !== "--page-only");
    if (positional.length > 2 || arguments_.length !== positional.length + (pageOnly ? 1 : 0)) {
      fail("usage: verify-config-site.mjs [site-path] [origin] [--page-only]");
    }
    const result = await verifyConfigSite({
      sitePath: positional[0] ?? DEFAULT_SITE_PATH,
      origin: positional[1] ?? process.env.CONFIG_SITE_ORIGIN,
      includeCatalog: !pageOnly,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
