import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigSite } from "../../../scripts/build-config-site.mjs";
import { verifyConfigSite } from "../../../scripts/verify-config-site.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lapin-fute-config-site-"));
  const pageSource = join(root, "page");
  const staticPath = join(root, "catalog");
  const outputPath = join(root, "output");
  mkdirSync(pageSource);
  writeFileSync(join(pageSource, "index.html"), "<h1>Lapin Futé</h1>");
  for (const directory of ["src", "styles", "assets"]) {
    mkdirSync(join(pageSource, directory));
    writeFileSync(join(pageSource, directory, "fixture.txt"), directory);
  }
  return { root, pageSource, staticPath, outputPath };
}

test("page-only configuration build neither requires nor publishes a catalog", () => {
  const paths = fixture();
  try {
    buildConfigSite({ ...paths, includeCatalog: false });
    assert.equal(readFileSync(join(paths.outputPath, "index.html"), "utf8"), "<h1>Lapin Futé</h1>");
    assert.equal(existsSync(join(paths.outputPath, "catalog")), false);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("full configuration build still requires and copies a published catalog", () => {
  const paths = fixture();
  try {
    assert.throws(
      () => buildConfigSite(paths),
      /no published static catalog/u,
    );

    mkdirSync(join(paths.staticPath, "revision"), { recursive: true });
    writeFileSync(join(paths.staticPath, "manifest.json"), '{"revision":"fixture"}');
    writeFileSync(join(paths.staticPath, "revision", "0.json"), "{}");
    buildConfigSite(paths);

    assert.equal(
      readFileSync(join(paths.outputPath, "catalog", "manifest.json"), "utf8"),
      '{"revision":"fixture"}',
    );
    assert.equal(existsSync(join(paths.outputPath, "catalog", "revision", "0.json")), true);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("configuration-site verification checks every local and served file on the current catalog revision", async () => {
  const paths = fixture();
  try {
    const revision = "a".repeat(64);
    const manifest = {
      schemaVersion: 1,
      revision,
      sourceRevision: "idfm-v1-fixture",
      createdAt: "2026-09-13T00:00:00.000Z",
      attribution: [{
        dataset: "fixture",
        url: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/fixture",
        retrievedAt: "2026-09-13T00:00:00.000Z",
        license: "Licence fixture",
      }],
    };
    const files = new Map([
      ["index.html", "<h1>Lapin Futé</h1>"],
      ["catalog/manifest.json", JSON.stringify(manifest)],
      [`catalog/${revision}/search/a/0.json`, JSON.stringify({
        schemaVersion: 1, revision, page: 0, nextPage: null, places: [],
      })],
      [`catalog/${revision}/places/plc_${"a".repeat(43)}/0.json`, JSON.stringify({
        schemaVersion: 1, revision, placeId: `plc_${"a".repeat(43)}`, page: 0, nextPage: null, services: [],
      })],
      [`catalog/${revision}/services/svc_${"b".repeat(43)}.json`, JSON.stringify({
        schemaVersion: 1, revision, service: {},
      })],
    ]);
    for (const [relativePath, body] of files) {
      const path = join(paths.outputPath, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    }

    const requested = [];
    const result = await verifyConfigSite({
      sitePath: paths.outputPath,
      origin: "https://config.example.test/lapin-fute/",
      fetcher: async (url) => {
        requested.push(url.href);
        const relativePath = decodeURIComponent(url.pathname.slice("/lapin-fute/".length));
        const body = files.get(relativePath);
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body, { status: 200 });
      },
    });

    assert.equal(result.revision, revision);
    assert.equal(result.fileCount, files.size);
    assert.equal(result.catalogJsonCount, 3);
    assert.deepEqual(requested.sort(), [...files.keys()]
      .map((path) => `https://config.example.test/lapin-fute/${path}`)
      .sort());

    files.set(`catalog/${revision}/services/svc_${"b".repeat(43)}.json`, "{}");
    await assert.rejects(
      verifyConfigSite({
        sitePath: paths.outputPath,
        origin: "https://config.example.test/lapin-fute/",
        fetcher: async (url) => new Response(files.get(
          decodeURIComponent(url.pathname.slice("/lapin-fute/".length)),
        ), { status: 200 }),
      }),
      /served bytes differ/u,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Bunny releases deploy production tags while preview tags stop after quality checks", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/deploy-bunny.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /branches:\s*\[develop\]/u);
  assert.match(workflow, /tags:\s*\["v\*", "pre-v\*"\]/u);
  assert.match(workflow, /startsWith\(github\.ref_name, 'v'\)/u);
  assert.match(workflow, /publish:\s+name: Publish GitHub release notes[\s\S]+needs: \[test, deploy\]/u);
  assert.match(workflow, /\["log", "--first-parent", "-z", "--format=%s%x00%h"/u);
  for (const title of ["Features", "Changes", "Fixes", "CI"]) {
    assert.match(workflow, new RegExp(`title: "${title}"`, "u"));
  }
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"[\s\S]+--notes-file release-notes\.md[\s\S]+--verify-tag/u);
  assert.doesNotMatch(workflow, /--generate-notes/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.refresh_catalog/u);
  assert.match(workflow, /refresh_catalog:\s+description:[\s\S]+type: boolean/u);
  assert.match(workflow, /inputs\.refresh_catalog != true[\s\S]+npm run build:config-page/u);
  assert.match(workflow, /inputs\.refresh_catalog \}\}[\s\S]+npm run catalog:refresh/u);
  assert.match(
    workflow,
    /if \[\[ -f var\/config-site\/catalog\/manifest\.json \]\]; then\s+upload_file/u,
  );
});
