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
  throw new Error(`build:config-site failed: ${message}`);
}

function copyCatalog(staticPath, outputPath) {
  const manifest = join(staticPath, "manifest.json");
  if (!existsSync(manifest)) {
    fail(`no published static catalog at ${staticPath} (manifest.json missing). Run "npm run catalog:refresh" first.`);
  }

  const catalogTarget = join(outputPath, "catalog");
  mkdirSync(catalogTarget, { recursive: true });
  for (const entry of readdirSync(staticPath)) {
    cpSync(join(staticPath, entry), join(catalogTarget, entry), { recursive: true });
  }
  if (!existsSync(join(catalogTarget, "manifest.json"))) {
    fail("catalog copy did not produce manifest.json");
  }
}

function copyPage(pageSource, outputPath) {
  for (const entry of PAGE_ENTRIES) {
    const source = join(pageSource, entry);
    if (!existsSync(source)) fail(`missing config page source: ${entry}`);
    if (statSync(source).isDirectory()) {
      cpSync(source, join(outputPath, entry), { recursive: true });
    } else {
      cpSync(source, join(outputPath, entry));
    }
  }
}

export function buildConfigSite({
  pageSource = PAGE_SOURCE,
  staticPath = STATIC_PATH,
  outputPath = OUTPUT_PATH,
  includeCatalog = true,
} = {}) {
  if (includeCatalog && !existsSync(staticPath)) {
    fail(`no published static catalog at ${staticPath}. Run "npm run catalog:refresh" first.`);
  }

  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(outputPath, { recursive: true });
  try {
    copyPage(pageSource, outputPath);
    if (includeCatalog) copyCatalog(staticPath, outputPath);
  } catch (error) {
    rmSync(outputPath, { recursive: true, force: true });
    throw error;
  }

  console.log(includeCatalog
    ? `config site ready: ${outputPath} (catalog revision in catalog/manifest.json)`
    : `config page ready: ${outputPath} (existing hosted catalog left unchanged)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--page-only") || arguments_.length > 1) {
    console.error('build:config-site failed: the only supported option is "--page-only"');
    process.exitCode = 1;
  } else {
    try {
      buildConfigSite({ includeCatalog: arguments_[0] !== "--page-only" });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
