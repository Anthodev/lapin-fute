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
    const placeId = `plc_${"a".repeat(43)}`;
    const serviceId = `svc_${"b".repeat(43)}`;
    const place = {
      placeId,
      stopLabel: "Gare du Nord",
      localityLabel: "Paris",
      mode: "BUS",
      lines: [{ lineLabel: "42", lineColor: "#e86a10", lineTextColor: "#ffffff" }],
      searchText: "gare du nord paris",
    };
    const service = {
      serviceId,
      stopLabel: "Gare du Nord",
      lineLabel: "42",
      destinationLabel: "Hôpital Européen",
      lineMode: "BUS",
      lineColor: "#e86a10",
      lineTextColor: "#ffffff",
      routing: {
        monitoringRef: "fixture-monitoring",
        lineRef: "fixture-line",
        destinationRef: "fixture-destination",
      },
    };
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
        schemaVersion: 1, revision, page: 0, nextPage: null, places: [place],
      })],
      [`catalog/${revision}/places/${placeId}/0.json`, JSON.stringify({
        schemaVersion: 1, revision, placeId, page: 0, nextPage: null, services: [service],
      })],
      [`catalog/${revision}/services/${serviceId}.json`, JSON.stringify({
        schemaVersion: 1, revision, service,
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

    const servicePath = `catalog/${revision}/services/${serviceId}.json`;
    writeFileSync(join(paths.outputPath, servicePath), JSON.stringify({
      schemaVersion: 1,
      revision,
      service: {},
    }));
    await assert.rejects(
      verifyConfigSite({
        sitePath: paths.outputPath,
        origin: "https://config.example.test/lapin-fute/",
        fetcher: async () => new Response(null, { status: 404 }),
      }),
      /does not satisfy the static catalog contract/u,
    );
    writeFileSync(join(paths.outputPath, servicePath), files.get(servicePath));

    files.set(servicePath, "{}");
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
  const rollbackWorkflow = readFileSync(
    new URL("../../../.github/workflows/rollback-bunny.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /branches:\s*\[develop\]/u);
  assert.match(workflow, /tags:\s*\["v\*", "pre-v\*"\]/u);
  assert.match(workflow, /startsWith\(github\.ref_name, 'v'\)/u);
  assert.match(workflow, /package:\s+name: Build release PBW[\s\S]+needs: test/u);
  assert.match(workflow, /oven-sh\/setup-bun@[a-f0-9]{40} # v2\.2\.0/u);
  assert.match(workflow, /astral-sh\/setup-uv@[a-f0-9]{40} # v6\.8\.0/u);
  assert.match(workflow, /pebble-tool==5\.0\.40[\s\S]+pebble sdk install 4\.33\.1/u);
  assert.match(workflow, /LAPIN_FUTE_CONFIG_URL: \$\{\{ vars\.CONFIG_SITE_ORIGIN \}\}[\s\S]+npm run build/u);
  assert.match(workflow, /sha256sum "lapin-fute-\$RELEASE_TAG\.pbw" > SHA256SUMS/u);
  assert.match(workflow, /publish:\s+name: Publish GitHub release notes[\s\S]+needs: \[test, package, deploy\]/u);
  assert.match(workflow, /\["log", "--first-parent", "-z", "--format=%s%x00%h"/u);
  for (const title of ["Features", "Changes", "Fixes", "CI"]) {
    assert.match(workflow, new RegExp(`title: "${title}"`, "u"));
  }
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"[\s\S]+--notes-file release-notes\.md[\s\S]+--verify-tag[\s\S]+release-assets\/\*/u);
  assert.doesNotMatch(workflow, /--generate-notes/u);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.refresh_catalog/u);
  assert.match(workflow, /refresh_catalog:\s+description:[\s\S]+type: boolean/u);
  assert.match(workflow, /Refresh production catalog[\s\S]+npm run catalog:refresh/u);
  assert.match(workflow, /Build static configuration site[\s\S]+npm run build:config-site/u);
  assert.doesNotMatch(workflow, /npm run build:config-page/u);
  assert.match(
    workflow,
    /if \[\[ -f var\/config-site\/catalog\/manifest\.json \]\]; then\s+upload_file/u,
  );
  assert.match(workflow, /Back up mutable production files[\s\S]+id: backup/u);
  assert.match(workflow, /name: bunny-rollback-\$\{\{ github\.run_id \}\}[\s\S]+retention-days: 30/u);
  assert.match(workflow, /Verify served static site[\s\S]+npm run verify:config-site/u);
  assert.match(workflow, /failure\(\) && steps\.backup\.outcome == 'success'/u);
  assert.match(workflow, /Restoring \$relative_path[\s\S]+Removing newly introduced mutable file/u);
  assert.match(rollbackWorkflow, /deployment_run_id:[\s\S]+type: string/u);
  assert.match(rollbackWorkflow, /gh run download "\$DEPLOYMENT_RUN_ID"[\s\S]+bunny-rollback-\$DEPLOYMENT_RUN_ID/u);
  assert.match(rollbackWorkflow, /test "\$status" = completed[\s\S]+workflow_path" = "\.github\/workflows\/deploy-bunny\.yml"/u);
  assert.match(rollbackWorkflow, /head_repository" = "\$GH_REPO"[\s\S]+event" = workflow_dispatch/u);
  assert.match(rollbackWorkflow, /Restore previous mutable files[\s\S]+Purge Bunny CDN cache[\s\S]+Verify restored mutable files/u);
  assert.match(rollbackWorkflow, /CONFIG_SITE_ORIGIN must use HTTPS/u);
});
