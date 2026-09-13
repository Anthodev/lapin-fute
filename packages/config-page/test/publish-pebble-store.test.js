import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { publishPebbleStore } from "../../../scripts/publish-pebble-store.mjs";

const UUID = "f1e58d7b-8e42-4b21-a9bf-67c0f4b59d02";
const APP_ID = "6d6aa01b7ecb4cfea469a183";
const REFRESH = "private-refresh-fixture";
const ID_TOKEN = "private.id.fixture";
const STORE = "https://appstore-api.repebble.com";

// Stored ZIP entries keep these fixtures independent of external commands and build artifacts.
function archive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes);
    central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(t, { uuid = UUID, version = "1.0.1", entries, tag = "v1.0.1", checksum } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lapin-fute-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const members = entries ?? [
    ["appinfo.json", JSON.stringify({ uuid, versionLabel: version })],
    ["emery/manifest.json", "{}"], ["emery/pebble-app.bin", "emery binary"],
    ["gabbro/manifest.json", "{}"], ["gabbro/pebble-app.bin", "gabbro binary"],
  ];
  const bytes = archive(members);
  const filename = `lapin-fute-${tag}.pbw`;
  const pbwPath = join(root, filename);
  const checksumsPath = join(root, "SHA256SUMS");
  const notesPath = join(root, "notes.txt");
  const notes = "# Corrections\n\nDéparts & horaires améliorés.\n";
  writeFileSync(pbwPath, bytes);
  writeFileSync(checksumsPath, `${checksum ?? createHash("sha256").update(bytes).digest("hex")}  ${filename}\n`);
  writeFileSync(notesPath, notes);
  const logs = [];
  return { pbwPath, checksumsPath, notesPath, tag, refreshToken: REFRESH, bytes, notes, logs, log: (line) => logs.push(line) };
}

function remote(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    const index = calls.length - 1;
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (Object.hasOwn(overrides, index)) return overrides[index](url, options);
    if (index === 0) return Response.json({ id_token: ID_TOKEN, refresh_token: REFRESH });
    if (index === 1) return Response.json({ app_lookup: { by_app_uuid: { [UUID]: APP_ID } } });
    if (index === 2 || index === 3) return Response.json({ data: [{ id: APP_ID, uuid: UUID, latest_release: { version: "1.0.0" } }] });
    if (index === 4) return Response.json({});
    assert.fail("Unexpected retry or extra request");
  };
  return { fetcher, calls };
}

async function rejectsSafely(options, server, expectedRequests) {
  await assert.rejects(publishPebbleStore({ ...options, fetcher: server.fetcher }), (error) => {
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /private-refresh-fixture|private\.id\.fixture|remote-secret/u);
    return true;
  });
  assert.equal(server.calls.length, expectedRequests);
  assert.doesNotMatch(options.logs.join("\n"), /private-refresh-fixture|private\.id\.fixture|remote-secret/u);
}

test("local checksum, identity and tag validation fails before authentication", async (t) => {
  for (const [name, changes] of [
    ["wrong checksum", { checksum: "0".repeat(64) }],
    ["wrong UUID", { uuid: "another-application" }],
    ["wrong archive version", { version: "1.0.2" }],
    ["prerelease tag", { tag: "v1.0.1-rc.1" }],
  ]) {
    await t.test(name, async (t) => rejectsSafely(fixture(t, changes), remote(), 0));
  }
});

test("archive targets, duplicate metadata and oversized JSON fail before authentication", async (t) => {
  const metadata = ["appinfo.json", JSON.stringify({ uuid: UUID, versionLabel: "1.0.1" })];
  for (const [name, entries] of [
    ["missing target", [metadata, ["emery/manifest.json", "{}"], ["emery/pebble-app.bin", "binary"]]],
    ["duplicate metadata", [metadata, metadata]],
    ["oversized metadata", [["appinfo.json", " ".repeat(1024 * 1024 + 1)]]],
  ]) {
    await t.test(name, async (t) => rejectsSafely(fixture(t, { entries }), remote(), 0));
  }
});

test("ambiguous checksum records fail before authentication", async (t) => {
  const options = fixture(t);
  const line = `${createHash("sha256").update(options.bytes).digest("hex")}  lapin-fute-v1.0.1.pbw\n`;
  writeFileSync(options.checksumsPath, line + line);
  await rejectsSafely(options, remote(), 0);
});

test("an authenticated account without the exact app mapping cannot upload", async (t) => {
  await rejectsSafely(fixture(t), remote({
    1: () => Response.json({ app_lookup: { by_app_uuid: { [UUID]: "different-app" } } }),
  }), 2);
});

test("ownership lookup rejects conflicting UUID keys after normalization", async (t) => {
  await rejectsSafely(fixture(t), remote({
    1: () => Response.json({ app_lookup: { by_app_uuid: {
      [UUID]: APP_ID,
      [` ${UUID.toUpperCase()} `]: "different-app",
    } } }),
  }), 2);
});

test("either hardware's published version blocks equal or older candidates", async (t) => {
  for (const [name, index, version] of [["equal Emery", 2, "1.0.1"], ["newer Gabbro", 3, "1.1.0"]]) {
    await t.test(name, async (t) => rejectsSafely(fixture(t), remote({
      [index]: () => Response.json({ data: [{ id: APP_ID, uuid: UUID, latest_release: { version } }] }),
    }), index + 1));
  }
});

test("publication uploads the exact checked bytes and notes once, even if the file changes after validation", async (t) => {
  const options = fixture(t, { version: "1.0.10", tag: "v1.0.10" });
  const server = remote({
    0: () => {
      writeFileSync(options.pbwPath, "replaced after local validation");
      return Response.json({ id_token: ID_TOKEN, refresh_token: "rotated-private-token" });
    },
    1: () => Response.json({ app_lookup: { by_app_uuid: { [` ${UUID.toUpperCase()} `]: APP_ID } } }),
    2: () => Response.json({ data: [{ id: APP_ID, uuid: UUID, latest_release: { version: "1.0.9" } }] }),
  });
  await publishPebbleStore({ ...options, fetcher: server.fetcher });
  assert.deepEqual(server.calls.map((call) => [call.method, call.url]), [
    ["POST", "https://securetoken.googleapis.com/v1/token?key=AIzaSyBZ9Cdvwwv9At2lPmc8TxyyEqSXGXejGvc"],
    ["GET", `${STORE}/api/v1/developer/me`],
    ["GET", `${STORE}/api/v1/apps/id/${APP_ID}?hardware=emery`],
    ["GET", `${STORE}/api/v1/apps/id/${APP_ID}?hardware=gabbro`],
    ["POST", `${STORE}/api/dashboard/apps/${APP_ID}/releases`],
  ]);
  assert.deepEqual([...server.calls[0].body], [["grant_type", "refresh_token"], ["refresh_token", REFRESH]]);
  assert.equal(server.calls[1].headers.Authorization, `Bearer ${ID_TOKEN}`);
  assert.equal(server.calls[2].headers, undefined);
  assert.equal(server.calls[3].headers, undefined);
  const upload = server.calls[4];
  assert.equal(upload.headers.Authorization, `Bearer ${ID_TOKEN}`);
  assert.deepEqual([...upload.body.keys()].sort(), ["isPublished", "pbwFile", "releaseNotes", "replaceScreenshots", "version"]);
  const pbw = upload.body.get("pbwFile");
  assert.equal(pbw.name, "lapin-fute-v1.0.10.pbw");
  assert.deepEqual(Buffer.from(await pbw.arrayBuffer()), options.bytes);
  assert.equal(upload.body.get("releaseNotes"), options.notes);
  assert.equal(upload.body.get("version"), "1.0.10");
  assert.equal(upload.body.get("isPublished"), "true");
  assert.equal(upload.body.get("replaceScreenshots"), "false");
  assert.ok(options.logs.some((line) => line.includes("secret was not updated")));
  assert.doesNotMatch(options.logs.join("\n"), /private-refresh-fixture|private\.id\.fixture|rotated-private-token/u);
});

test("remote failure, redirect and malformed data never expose remote content or retry", async (t) => {
  for (const [name, index, response] of [
    ["revoked session", 0, () => new Response(`remote-secret ${REFRESH}`, { status: 400 })],
    ["invalid token", 0, () => Response.json({ id_token: "remote-secret\r\nInjected: true" })],
    ["malformed JSON", 1, () => new Response(`remote-secret ${ID_TOKEN}`)],
    ["oversized JSON", 1, () => Response.json({ ignored: "x".repeat(1024 * 1024) })],
    ["redirect", 1, () => new Response(null, { status: 302, headers: { location: "https://untrusted.example/" } })],
    ["wrong public identity", 2, () => Response.json({ data: [{ id: APP_ID, uuid: "wrong", latest_release: { version: "1.0.0" } }] })],
    ["unknown published version", 3, () => Response.json({ data: [{ id: APP_ID, uuid: UUID, latest_release: { version: "unknown" } }] })],
    ["upload HTTP error", 4, () => new Response(`remote-secret ${ID_TOKEN}`, { status: 500 })],
    ["uncertain upload timeout", 4, () => { throw new Error(`remote-secret ${REFRESH} ${ID_TOKEN}`); }],
  ]) {
    await t.test(name, async (t) => rejectsSafely(fixture(t), remote({ [index]: response }), index + 1));
  }
});
