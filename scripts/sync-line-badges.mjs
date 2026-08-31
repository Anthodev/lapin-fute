import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_ROOT = join(ROOT, "packages/config-page/assets");
const OUTPUT = join(ASSET_ROOT, "line-badges");
const RESOLVER = join(ROOT, "packages/config-page/src/line-badge-assets.js");
const ORIGIN = "https://data.iledefrance-mobilites.fr";
const DATASET = "referentiel-des-lignes";
const DATASET_URL = `${ORIGIN}/explore/dataset/${DATASET}/`;
const DATASET_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/";
const ILICO_TERMS_URL = "https://prim.iledefrance-mobilites.fr/fr/conditions-utilisation";
const TRUSTED_SVG_SHA256 = new Set([
  "7c79d62ae30950fe638667f63b0ec62bec9bc18a171b1309ca996e670d3d9e25",
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function fail(message) {
  throw new Error(message);
}

function safeLabel(value) {
  if (typeof value !== "string" || value.trim() === "") fail("Line label is missing");
  return value.trim();
}

function modeFor(record) {
  const mode = String(record.transportmode ?? "").trim().toLowerCase();
  const submode = String(record.transportsubmode ?? "").trim().toLowerCase();
  if (mode === "metro") return "METRO";
  if (mode === "tram") return "TRAM";
  if (mode === "rail" && submode === "local") return "RER";
  if (mode === "rail" && submode === "suburbanrailway") return "TRANSILIEN";
  return undefined;
}

function slug(value) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  const result = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(result)) fail(`Unsafe generated label: ${value}`);
  return result;
}

async function boundedFetch(url, expectedType) {
  const target = new URL(url);
  if (target.origin !== ORIGIN) fail(`Unexpected asset origin: ${target.origin}`);
  if (!target.pathname.startsWith(`/api/explore/v2.1/catalog/datasets/${DATASET}/`)) {
    fail(`Unexpected asset path: ${target.pathname}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: expectedType },
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) fail(`${target.pathname} returned HTTP ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > MAX_BODY_BYTES) fail(`${target.pathname} exceeds 2 MiB`);
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), type: (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() };
  } finally {
    clearTimeout(timeout);
  }
}

function validateImage(body, type, sha256) {
  if (type === "image/png") {
    if (body.length < 8 || !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail("Invalid PNG signature");
    return "png";
  }
  if (type !== "image/svg+xml") fail(`Unsupported badge media type: ${type}`);
  if (!TRUSTED_SVG_SHA256.has(sha256)) {
    fail(`Unreviewed SVG badge ${sha256}; review and pin it before publication`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (!/<svg\b/iu.test(source)
    || /<\s*(?:script|foreignObject|iframe|object|embed)\b/iu.test(source)
    || /\son[a-z]+\s*=/iu.test(source)
    || /(?:href|src)\s*=\s*["']\s*(?:javascript:|data:|https?:|\/\/)/iu.test(source)
    || /url\(\s*["']?\s*(?:javascript:|data:|https?:|\/\/)/iu.test(source)) {
    fail("Unsafe pinned SVG badge");
  }
  return "svg";
}

async function records() {
  const query = new URL(`/api/explore/v2.1/catalog/datasets/${DATASET}/records`, ORIGIN);
  query.searchParams.set("select", "name_line,shortname_line,transportmode,transportsubmode,status,picto");
  query.searchParams.set("where", "status = 'active' and (transportmode in ('metro','tram') or (transportmode = 'rail' and transportsubmode in ('local','suburbanRailway')))");
  query.searchParams.set("limit", "100");
  const { body, type } = await boundedFetch(query, "application/json");
  if (type !== "application/json") fail(`Unexpected records media type: ${type}`);
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!Number.isSafeInteger(payload.total_count) || !Array.isArray(payload.results) || payload.results.length !== payload.total_count) {
    fail("Incomplete line badge result set");
  }
  return payload.results;
}

async function main() {
  const selected = (await records()).map((record) => {
    const mode = modeFor(record);
    const label = safeLabel(record.shortname_line || record.name_line);
    const picto = record.picto;
    if (mode === undefined || picto === null || typeof picto !== "object" || typeof picto.url !== "string") return undefined;
    return { key: `${mode}:${label}`, mode, label, url: picto.url };
  }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key, "en"));

  const keys = new Set();
  for (const item of selected) {
    if (keys.has(item.key)) fail(`Duplicate public badge key: ${item.key}`);
    keys.add(item.key);
  }

  await mkdir(ASSET_ROOT, { recursive: true });
  const staging = `${OUTPUT}.tmp-${process.pid}`;
  const backup = `${OUTPUT}.bak-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  const manifest = [];
  const resolverEntries = [];
  try {
    for (const item of selected) {
      const { body, type } = await boundedFetch(item.url, "image/png,image/svg+xml");
      const sha256 = createHash("sha256").update(body).digest("hex");
      const extension = validateImage(body, type, sha256);
      const filename = `${item.mode.toLowerCase()}-${slug(item.label)}.${extension}`;
      await writeFile(join(staging, filename), body, { flag: "wx" });
      manifest.push({ key: item.key, file: filename, mediaType: type, bytes: body.length, sha256, source: item.url });
      resolverEntries.push([item.key, filename]);
    }

    const retrievedAt = new Date().toISOString();
    const attribution = {
      publisher: "Île-de-France Mobilités",
      dataset: DATASET,
      datasetUrl: DATASET_URL,
      datasetLicense: "ODbL 1.0",
      datasetLicenseUrl: DATASET_LICENSE_URL,
      pictogramReuseTermsUrl: ILICO_TERMS_URL,
      retrievedAt,
      assets: manifest,
    };
    await writeFile(join(staging, "attribution.json"), `${JSON.stringify(attribution, null, 2)}\n`);
    const resolver = `// Generated by scripts/sync-line-badges.mjs. Do not edit.\nconst ASSETS = new Map(${JSON.stringify(resolverEntries, null, 2)});\n\nexport function lineBadgeAssetUrl(lineMode, lineLabel) {\n  const file = ASSETS.get(\`${"${lineMode}:${lineLabel}"}\`);\n  return file === undefined ? undefined : new URL(\`../assets/line-badges/${"${file}"}\`, import.meta.url).href;\n}\n`;
    const resolverTemp = `${RESOLVER}.tmp-${process.pid}`;
    await writeFile(resolverTemp, resolver);
    await rm(backup, { recursive: true, force: true });
    try { await rename(OUTPUT, backup); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(staging, OUTPUT);
    await rename(resolverTemp, RESOLVER);
    await rm(backup, { recursive: true, force: true });
    const bytes = manifest.reduce((sum, asset) => sum + asset.bytes, 0);
    process.stdout.write(`${manifest.length} official badges synchronized (${bytes} bytes)\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    try { await rename(backup, OUTPUT); } catch (restoreError) { if (restoreError?.code !== "ENOENT") throw restoreError; }
    throw error;
  }
}

await main();
