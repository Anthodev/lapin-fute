import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCatalogManifest } from "../packages/config-page/src/catalog-client.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST_PATH = join(PROJECT_ROOT, "var/catalog/static/manifest.json");
const MANIFEST_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(`plan:catalog-upload failed: ${message}`);
}

function parseManifest(body, label) {
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (!isCatalogManifest(manifest)) fail(`${label} does not satisfy the static catalog contract`);
  return manifest;
}

function configurationOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail("CONFIG_SITE_ORIGIN must be an absolute HTTPS URL");
  }
  if (origin.protocol !== "https:"
      || origin.username !== ""
      || origin.password !== ""
      || origin.search !== ""
      || origin.hash !== "") {
    fail("CONFIG_SITE_ORIGIN must be an absolute HTTPS URL without credentials, query, or fragment");
  }
  if (!origin.pathname.endsWith("/")) origin.pathname += "/";
  return origin;
}

async function remoteManifest(origin, fetcher) {
  const url = new URL("catalog/manifest.json", origin);
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) fail(`${url.href} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MANIFEST_LIMIT_BYTES) {
    fail("hosted catalog manifest exceeds the response limit");
  }
  if (response.body === null) fail("hosted catalog manifest has no body");
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
      if (bytes > MANIFEST_LIMIT_BYTES) fail("hosted catalog manifest exceeds the response limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
  return parseManifest(Buffer.concat(chunks, bytes).toString("utf8"), "hosted catalog manifest");
}

export async function planCatalogUpload({
  manifestPath = DEFAULT_MANIFEST_PATH,
  origin,
  fetcher = globalThis.fetch,
} = {}) {
  const local = parseManifest(readFileSync(manifestPath, "utf8"), "generated catalog manifest");
  const remote = await remoteManifest(configurationOrigin(origin), fetcher);
  if (remote === null) {
    return { upload: true, reason: "hosted catalog manifest is missing", local, remote };
  }
  if (local.schemaVersion !== remote.schemaVersion) {
    return { upload: true, reason: "catalog schema changed", local, remote };
  }
  if (local.sourceRevision !== remote.sourceRevision) {
    return { upload: true, reason: "IDFM source revision changed", local, remote };
  }
  return { upload: false, reason: "IDFM source revision is already hosted", local, remote };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const plan = await planCatalogUpload({
      manifestPath: process.argv[2] ?? DEFAULT_MANIFEST_PATH,
      origin: process.argv[3] ?? process.env.CONFIG_SITE_ORIGIN,
    });
    console.error(`${plan.reason}: ${plan.local.sourceRevision}`);
    console.log(plan.upload ? "true" : "false");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
