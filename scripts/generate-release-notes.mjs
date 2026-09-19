import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const FENCED_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

// Advance the fenced-code state for one line. Returns null when no block is
// open, or { char, length } for the currently open fence marker.
function nextFence(line, open) {
  const match = line.match(FENCED_LINE);
  if (!match) return open;
  const [, marker, info] = match;
  if (open) {
    // A closing fence reuses the character, is at least as long, and has no info string.
    return marker[0] === open.char && marker.length >= open.length && info.trim() === "" ? null : open;
  }
  // A backtick fence's info string cannot contain backticks.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0], length: marker.length };
}

// Return the body of the `## [<version>] - date` section, without the heading
// itself. Headings and section boundaries inside fenced code blocks are
// ignored so code examples can neither duplicate nor truncate a section.
export function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^ {0,3}## \\[${escaped}\\](?:[ \\t].*)?$`, "u");
  const lines = changelog.replace(/\r\n?/gu, "\n").split("\n");
  let open = null;
  let sections = 0;
  let collected = null;
  let collecting = false;
  for (const line of lines) {
    if (FENCED_LINE.test(line)) open = nextFence(line, open);
    if (open) {
      // Fenced content is part of the section; only heading detection ignores it.
      if (collecting) collected.push(line);
      continue;
    }
    if (heading.test(line)) {
      sections += 1;
      collecting = sections === 1;
      if (collecting) collected = [];
      continue;
    }
    if (!collecting) continue;
    if (/^ {0,3}## /u.test(line)) {
      // Another section began; keep scanning so a duplicated version heading
      // cannot hide after it.
      collecting = false;
      continue;
    }
    collected.push(line);
  }
  if (sections === 0) throw new Error(`CHANGELOG.md has no section for version ${version}; expected a "## [${version}] - date" heading`);
  if (sections > 1) throw new Error(`CHANGELOG.md has ${sections} sections for version ${version}; expected exactly one`);
  const content = collected.join("\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
  if (!content) throw new Error(`CHANGELOG.md section for version ${version} is empty`);
  return `${content}\n`;
}

export function generateReleaseNotes({ tag, revision = tag, cwd = process.cwd() }) {
  if (!STABLE_TAG.test(tag)) throw new Error("Release tag must be a strict stable version: vMAJOR.MINOR.PATCH");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const currentCommit = git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim();
  const taggedCommit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`).trim();
  if (currentCommit !== taggedCommit) throw new Error("Release revision does not match its tag");
  let changelog;
  try {
    changelog = git("show", `${currentCommit}:CHANGELOG.md`);
  } catch {
    throw new Error(`CHANGELOG.md is missing at the tagged revision of ${tag}`);
  }
  return extractChangelogSection(changelog, tag.slice(1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync("release-notes.md", generateReleaseNotes({
    tag: process.env.GITHUB_REF_NAME,
    revision: process.env.GITHUB_SHA,
  }));
}
