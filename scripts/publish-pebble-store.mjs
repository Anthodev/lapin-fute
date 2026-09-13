import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import yauzl from "yauzl";

// Dashboard upload contract follows pebble-tool 5.0.40; it is not a public API guarantee.
// https://github.com/coredevices/pebble-tool/blob/fa7a5c4ba102e27194e6c76e36e0ceeadab0280b/pebble_tool/commands/publish.py
const APP_ID = "6d6aa01b7ecb4cfea469a183";
const APP_UUID = "f1e58d7b-8e42-4b21-a9bf-67c0f4b59d02";
const STORE = "https://appstore-api.repebble.com";
// Public Firebase project configuration from pebble-tool 5.0.40, not a credential.
const TOKEN_URL = "https://securetoken.googleapis.com/v1/token?key=AIzaSyBZ9Cdvwwv9At2lPmc8TxyyEqSXGXejGvc";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_JSON = 1024 * 1024;

async function readBounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("Size limit exceeded");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function versionParts(value) {
  if (typeof value !== "string" || value.length > 64 || value.trim() !== value || !VERSION.test(value)) {
    throw new Error("Invalid version");
  }
  return value.split(".").map(BigInt);
}

function newerThan(candidate, published) {
  const previous = versionParts(published);
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== previous[index]) return candidate[index] > previous[index];
  }
  return false;
}

async function readAppInfo(bytes) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
  return new Promise((resolve, reject) => {
    const members = new Map();
    let appInfo;
    const fail = (error) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", async (entry) => {
      try {
        if (members.has(entry.fileName) || members.size >= 4096) throw new Error("Invalid archive entries");
        members.set(entry.fileName, entry.uncompressedSize);
        if (entry.fileName === "appinfo.json" || /^(emery|gabbro)\/manifest\.json$/u.test(entry.fileName)) {
          if (entry.uncompressedSize > MAX_JSON) throw new Error("Archive metadata too large");
          const stream = await new Promise((resolveStream, rejectStream) => {
            zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value));
          });
          const metadata = JSON.parse((await readBounded(stream, MAX_JSON)).toString("utf8"));
          if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
            throw new Error("Invalid archive metadata");
          }
          if (entry.fileName === "appinfo.json") appInfo = metadata;
        }
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on("end", () => {
      zip.close();
      if (!appInfo || ["emery", "gabbro"].some((hardware) =>
        !members.get(`${hardware}/manifest.json`) || !members.get(`${hardware}/pebble-app.bin`))) {
        reject(new Error("Missing archive metadata or target"));
      } else resolve(appInfo);
    });
    zip.readEntry();
  });
}

// All diagnostics are fixed strings. Never attach remote exceptions or response bodies.
export async function publishPebbleStore({
  pbwPath, checksumsPath, tag, notesPath, refreshToken, fetcher = fetch, log = console.log,
}) {
  let stage = "Local release validation failed; no Store request was made.";
  try {
    if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error("Invalid tag");
    const version = tag.slice(1);
    const candidate = versionParts(version);
    const filename = `lapin-fute-${tag}.pbw`;
    if (basename(pbwPath) !== filename) throw new Error("Unexpected artifact name");
    const bytes = await readBounded(createReadStream(pbwPath), 32 * 1024 * 1024);
    const checksums = (await readBounded(createReadStream(checksumsPath), MAX_JSON)).toString("utf8");
    const notes = (await readBounded(createReadStream(notesPath), MAX_JSON)).toString("utf8");
    const matching = checksums.split(/\r?\n/u).filter((line) => line.endsWith(`  ${filename}`) || line.endsWith(` *${filename}`));
    if (matching.length !== 1 || !/^[a-fA-F0-9]{64} [ *]/u.test(matching[0]) ||
        matching[0].slice(66) !== filename ||
        matching[0].slice(0, 64).toLowerCase() !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error("Checksum mismatch");
    }
    const appInfo = await readAppInfo(bytes);
    if (appInfo.uuid !== APP_UUID || appInfo.versionLabel !== version) throw new Error("Archive identity mismatch");
    if (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > 16384 || /\s/u.test(refreshToken)) {
      stage = "PEBBLE_FIREBASE_REFRESH_TOKEN is missing or invalid; no Store request was made.";
      throw new Error("Invalid refresh token");
    }

    // The timeout remains active while reading the response body. No redirects or retries.
    async function request(url, options, timeout, json = true) {
      const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
      if (response.redirected || response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new Error("Remote request failed");
      }
      if (!json) {
        await response.body?.cancel();
        return;
      }
      const payload = JSON.parse((await readBounded(response.body, MAX_JSON)).toString("utf8"));
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid response");
      return payload;
    }

    stage = "Firebase session refresh failed. Renew the pebble login session and replace the environment secret if revoked.";
    const token = await request(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    }, 20000);
    if (typeof token.id_token !== "string" || token.id_token.length === 0 || token.id_token.length > 16384 ||
        !/^[A-Za-z0-9._~-]+$/u.test(token.id_token)) throw new Error("Invalid ID token");
    if (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || !token.refresh_token)) {
      throw new Error("Invalid refreshed session");
    }
    if (token.refresh_token !== undefined && token.refresh_token !== refreshToken) {
      log("Firebase returned a changed refresh token. The environment secret was not updated; renew pebble login and replace that secret before the next publication.");
    }
    const headers = { Authorization: `Bearer ${token.id_token}` };
    stage = "Store account verification failed; no release upload was attempted.";
    const owner = await request(`${STORE}/api/v1/developer/me`, { method: "GET", headers }, 60000);
    const lookup = owner.app_lookup?.by_app_uuid;
    if (lookup === null || typeof lookup !== "object" || Array.isArray(lookup)) throw new Error("Invalid app lookup");
    const matches = Object.entries(lookup).filter(([uuid]) => uuid.trim().toLowerCase() === APP_UUID);
    if (matches.length !== 1 || matches[0][1] !== APP_ID) throw new Error("Application not owned unambiguously");

    stage = "Store version verification failed or this version is already published; no release upload was attempted.";
    for (const hardware of ["emery", "gabbro"]) {
      const listing = await request(`${STORE}/api/v1/apps/id/${APP_ID}?hardware=${hardware}`, { method: "GET" }, 60000);
      if (!Array.isArray(listing.data) || listing.data.length !== 1) throw new Error("Invalid app listing");
      const app = listing.data[0];
      if (app?.id !== APP_ID || app.uuid !== APP_UUID || !newerThan(candidate, app.latest_release?.version)) {
        throw new Error("Published version or identity mismatch");
      }
    }

    const form = new FormData();
    form.set("pbwFile", new Blob([bytes], { type: "application/octet-stream" }), filename);
    form.set("version", version);
    form.set("releaseNotes", notes);
    form.set("isPublished", "true");
    form.set("replaceScreenshots", "false");
    stage = "Store upload failed or its outcome is uncertain. Inspect the developer dashboard before rerunning; do not assume no release was created.";
    await request(`${STORE}/api/dashboard/apps/${APP_ID}/releases`, { method: "POST", headers, body: form }, 300000, false);
    log("Store accepted the release upload from the validated GitHub release artifact.");
  } catch {
    throw new Error(stage);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      pbw: { type: "string" }, checksums: { type: "string" }, tag: { type: "string" }, "notes-file": { type: "string" },
    } });
    if (Object.values(values).length !== 4 || Object.values(values).some((value) => !value)) {
      throw new Error("Missing arguments");
    }
    await publishPebbleStore({
      pbwPath: values.pbw, checksumsPath: values.checksums, tag: values.tag, notesPath: values["notes-file"],
      refreshToken: process.env.PEBBLE_FIREBASE_REFRESH_TOKEN,
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } catch {
    console.error("Usage: node scripts/publish-pebble-store.mjs --pbw PATH --checksums PATH --tag vX.Y.Z --notes-file PATH");
    process.exitCode = 1;
  }
}
