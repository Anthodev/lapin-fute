import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the deployable static configuration site: the config page sources
// plus the published static catalog under catalog/ beside index.html.
// Sources (packages/config-page) and data (var/catalog/static) stay separate;
// publication fails explicitly when no real catalog was published. There is
// deliberately no fixture fallback: a deployable site must carry a real
// published catalog, never recorded test data.

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_SOURCE = join(PROJECT_ROOT, "packages/config-page");
const DEFAULT_STATIC_PATH = join(PROJECT_ROOT, "var/catalog/static");
const STATIC_PATH = resolve(process.env.CATALOG_STATIC_PATH ?? DEFAULT_STATIC_PATH);
const OUTPUT_PATH = join(PROJECT_ROOT, "var/config-site");
const PAGE_ENTRIES = ["index.html", "src", "styles", "assets"];

function fail(message) {
  console.error(`build:config-site failed: ${message}`);
  process.exit(1);
}

function copyCatalog() {
  const manifest = join(STATIC_PATH, "manifest.json");
  if (!existsSync(manifest)) {
    fail(`no published static catalog at ${STATIC_PATH} (manifest.json missing). Run "npm run catalog:refresh" first.`);
  }

  const catalogTarget = join(OUTPUT_PATH, "catalog");
  mkdirSync(catalogTarget, { recursive: true });
  for (const entry of readdirSync(STATIC_PATH)) {
    cpSync(join(STATIC_PATH, entry), join(catalogTarget, entry), { recursive: true });
  }
  if (!existsSync(join(catalogTarget, "manifest.json"))) {
    fail("catalog copy did not produce manifest.json");
  }
}

function copyPage() {
  for (const entry of PAGE_ENTRIES) {
    const source = join(PAGE_SOURCE, entry);
    if (!existsSync(source)) fail(`missing config page source: ${entry}`);
    if (statSync(source).isDirectory()) {
      cpSync(source, join(OUTPUT_PATH, entry), { recursive: true });
    } else {
      cpSync(source, join(OUTPUT_PATH, entry));
    }
  }
}

function build() {
  if (!existsSync(STATIC_PATH)) {
    fail(`no published static catalog at ${STATIC_PATH}. Run "npm run catalog:refresh" first.`);
  }

  rmSync(OUTPUT_PATH, { recursive: true, force: true });
  mkdirSync(OUTPUT_PATH, { recursive: true });
  try {
    copyPage();
    copyCatalog();
  } catch (error) {
    rmSync(OUTPUT_PATH, { recursive: true, force: true });
    throw error;
  }

  console.log(`config site ready: ${OUTPUT_PATH} (catalog revision in catalog/manifest.json)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
