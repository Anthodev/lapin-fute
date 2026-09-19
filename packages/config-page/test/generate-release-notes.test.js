import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChangelogSection, generateReleaseNotes } from "../../../scripts/generate-release-notes.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [1.1.0] - 2026-09-19",
  "",
  "Favorites now pair a departure stop with a reachable arrival stop.",
  "",
  "### Features",
  "",
  "- feat(arrivals): support departure-to-arrival favorites (#28) (`102d719`)",
  "",
  "**Full changelog**: https://github.com/example/app/compare/v1.0.4...v1.1.0",
  "",
  "[Release v1.1.0](https://github.com/example/app/releases/tag/v1.1.0)",
  "",
  "## [1.0.4] - 2026-09-14",
  "",
  "This release fixes partial-service arrival pooling.",
  "",
].join("\n");

test("release body keeps the whole section and excludes adjacent releases and the heading", () => {
  const notes = extractChangelogSection(CHANGELOG, "1.1.0");
  assert.match(notes, /^Favorites now pair a departure stop/u);
  assert.match(notes, /### Features\n\n- feat\(arrivals\): support departure-to-arrival favorites \(#28\) \(`102d719`\)/u);
  assert.match(notes, /\*\*Full changelog\*\*: https:\/\/github\.com\/example\/app\/compare\/v1\.0\.4\.\.\.v1\.1\.0/u);
  assert.match(notes, /\[Release v1\.1\.0\]\(https:\/\/github\.com\/example\/app\/releases\/tag\/v1\.1\.0\)/u);
  assert.doesNotMatch(notes, /## \[1\.1\.0\]|partial-service|Changelog/u);
  assert.match(notes, /\n$/u);
});

test("adjacent releases stay isolated regardless of heading position", () => {
  const notes = extractChangelogSection(CHANGELOG, "1.0.4");
  assert.match(notes, /^This release fixes partial-service arrival pooling\.$/mu);
  assert.doesNotMatch(notes, /departure stop|Features|Release v1\.1\.0/u);
});

test("exact bracket match does not confuse similar versions", () => {
  const changelog = ["## [1.10.0] - 2026-09-19", "", "ten", "", "## [1.1.0] - 2026-09-19", "", "one", ""].join("\n");
  assert.equal(extractChangelogSection(changelog, "1.1.0"), "one\n");
  assert.equal(extractChangelogSection(changelog, "1.10.0"), "ten\n");
});

test("fenced code examples can neither duplicate nor truncate a section", () => {
  const changelog = [
    "## [1.1.0] - 2026-09-19",
    "",
    "Intro before example.",
    "",
    "```md",
    "## [1.1.0] - fake",
    "## [9.9.9] - fake",
    "fake body",
    "```",
    "",
    "Outro after example.",
    "",
    "## [1.0.4] - 2026-09-14",
    "",
    "previous release",
    "",
  ].join("\n");
  const notes = extractChangelogSection(changelog, "1.1.0");
  assert.match(notes, /Intro before example\./u);
  assert.match(notes, /## \[1\.1\.0\] - fake\n## \[9\.9\.9\] - fake\nfake body/u);
  assert.match(notes, /Outro after example\./u);
  assert.doesNotMatch(notes, /previous release/u);
});

test("a fenced heading before any real section is not a section", () => {
  const changelog = ["# Changelog", "", "```md", "## [1.1.0] - fake", "```", "", "## [1.1.0] - 2026-09-19", "", "real", ""].join("\n");
  assert.equal(extractChangelogSection(changelog, "1.1.0"), "real\n");
});

test("tilde fences and CRLF line endings are handled like backtick fences", () => {
  const changelog = [
    "## [1.1.0] - 2026-09-19",
    "",
    "~~~",
    "## [1.0.4] - fake",
    "~~~",
    "",
    "kept",
    "",
    "## [1.0.4] - 2026-09-14",
  ].join("\r\n");
  const notes = extractChangelogSection(changelog, "1.1.0");
  assert.match(notes, /## \[1\.0\.4\] - fake/u);
  assert.match(notes, /kept/u);
});

test("missing, empty, and duplicate sections are rejected", () => {
  assert.throws(() => extractChangelogSection(CHANGELOG, "1.0.5"), /no section for version 1\.0\.5/u);
  assert.throws(() => extractChangelogSection("## [1.1.0] - 2026-09-19\n\n## [1.0.4] - 2026-09-14\n", "1.1.0"), /is empty/u);
  const duplicated = ["## [1.1.0] - 2026-09-19", "", "first", "", "## [1.1.0] - 2026-09-19", "", "second", ""].join("\n");
  assert.throws(() => extractChangelogSection(duplicated, "1.1.0"), /2 sections for version 1\.1\.0/u);
});

test("a duplicate section is rejected even when separated by another release", () => {
  const changelog = [
    "## [1.1.0] - 2026-09-19",
    "",
    "first",
    "",
    "## [1.0.4] - 2026-09-14",
    "",
    "older release",
    "",
    "## [1.1.0] - 2026-09-19",
    "",
    "second",
    "",
  ].join("\n");
  assert.throws(() => extractChangelogSection(changelog, "1.1.0"), /2 sections for version 1\.1\.0/u);
  assert.equal(extractChangelogSection(changelog, "1.0.4"), "older release\n");
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "lapin-fute-release-notes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git("init", "--quiet");
  function commit(subject, parents = [], files = {}) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
    git("add", "--", ...Object.keys(files));
    const tree = git("write-tree");
    return git("commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", subject);
  }
  const root = commit("chore: initialize", [], { "app.txt": "root" });
  return { cwd, git, commit, root, notes: (tag, revision = tag) => generateReleaseNotes({ cwd, tag, revision }) };
}

test("release notes come from the tagged changelog, never the working copy", (t) => {
  const f = fixture(t);
  const tagged = f.commit("chore: release", [f.root], {
    "CHANGELOG.md": ["## [1.1.0] - 2026-09-19", "", "- feat: tagged feature (`102d719`)", ""].join("\n"),
  });
  f.git("tag", "v1.1.0", tagged);
  writeFileSync(join(f.cwd, "CHANGELOG.md"), ["## [1.1.0] - 2026-09-19", "", "- feat: uncommitted change", ""].join("\n"));
  const notes = f.notes("v1.1.0", tagged);
  assert.match(notes, /- feat: tagged feature \(`102d719`\)/u);
  assert.doesNotMatch(notes, /uncommitted change/u);
});

test("a changelog committed after the tag cannot leak into the tagged release", (t) => {
  const f = fixture(t);
  const tagged = f.commit("chore: release", [f.root], {
    "CHANGELOG.md": ["## [1.1.0] - 2026-09-19", "", "- feat: tagged feature", ""].join("\n"),
  });
  f.git("tag", "v1.1.0", tagged);
  const later = f.commit("docs: edit changelog", [tagged], {
    "CHANGELOG.md": ["## [1.1.0] - 2026-09-19", "", "- feat: edited after tagging", ""].join("\n"),
  });
  assert.doesNotMatch(f.notes("v1.1.0", tagged), /edited after tagging/u);
  assert.throws(() => f.notes("v1.1.0", later), /does not match its tag/u);
});

test("releases reject non-stable tags and repositories without a tagged changelog", (t) => {
  const f = fixture(t);
  for (const tag of [undefined, "v1.0", "v1.0.0-rc.1", "v01.0.0", "pre-v1-0.0"]) {
    assert.throws(() => f.notes(tag), /strict stable version/u);
  }
  f.git("tag", "v1.1.0", f.root);
  assert.throws(() => f.notes("v1.1.0", f.root), /CHANGELOG\.md is missing/u);
});
