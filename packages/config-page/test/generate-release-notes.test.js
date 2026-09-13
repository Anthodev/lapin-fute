import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReleaseNotes } from "../../../scripts/generate-release-notes.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "lapin-fute-release-notes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git("init", "--quiet");
  function commit(subject, content, parents = [], filename = "app.txt") {
    writeFileSync(join(cwd, filename), content);
    git("add", "--", filename);
    const tree = git("write-tree");
    return git("commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", subject);
  }
  const root = commit("chore: initialize", "root");
  return {
    git, commit, root,
    notes: (tag, revision = tag) => generateReleaseNotes({ cwd, tag, revision, repository: "example/app" }),
  };
}

test("empty commit subjects do not consume the following categorized commit", (t) => {
  const f = fixture(t);
  f.git("tag", "v1.0.0", f.root);
  const fix = f.commit("fix: preserve this change", "fixed", [f.root]);
  f.git("update-ref", "HEAD", fix);
  f.git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "--allow-empty", "--allow-empty-message", "-m", "");
  const empty = f.git("rev-parse", "HEAD");
  f.git("tag", "v1.0.1", empty);
  const notes = f.notes("v1.0.1");
  assert.ok(notes.includes(`## Changes\n\n- (no commit subject) (\`${f.git("rev-parse", "--short", empty)}\`)`));
  assert.ok(notes.includes(`## Fixes\n\n- fix: preserve this change (\`${f.git("rev-parse", "--short", fix)}\`)`));
  assert.doesNotMatch(notes, /initialize/u);
});

test("numeric stable predecessor excludes future, prerelease, build and malformed tags", (t) => {
  const f = fixture(t);
  const old = f.commit("feat: already shipped", "old", [f.root]);
  for (const tag of ["v1.9.9", "v1.10.0"]) f.git("tag", tag, old);
  const misleading = f.commit("fix: belongs in these notes", "intermediate", [old]);
  for (const tag of ["v1.10.1-rc.1", "v1.10.1+build", "v01.10.1", "v1.10.1junk", "v1.11.0", "v2.0.0"]) f.git("tag", tag, misleading);
  const current = f.commit("ci: release", "current", [misleading]);
  f.git("tag", "v1.10.1", current);
  const notes = f.notes("v1.10.1");
  assert.match(notes, /compare\/v1\.10\.0\.\.\.v1\.10\.1/u);
  assert.match(notes, /## Fixes\n\n- fix: belongs in these notes/u);
  assert.match(notes, /## CI\n\n- ci: release/u);
  assert.doesNotMatch(notes, /already shipped|initialize/u);
});

test("stable version comparison retains precision beyond Number safe integers", (t) => {
  const f = fixture(t);
  f.git("tag", "v9007199254740992.0.0", f.root);
  f.git("tag", "v9007199254740993.0.0", f.root);
  const current = f.commit("fix: new", "new", [f.root]);
  f.git("tag", "v9007199254740994.0.0", current);
  assert.match(f.notes("v9007199254740994.0.0"), /compare\/v9007199254740993\.0\.0\.\.\.v9007199254740994\.0\.0/u);
});

test("divergent release uses net trees without replaying historical or squash commits", (t) => {
  const f = fixture(t);
  const previous = f.commit("feat: huge old feature", "released", [f.root]);
  f.git("tag", "v1.0.0", previous);
  const squash = f.commit("feat: ship all old features", "released", [f.root]);
  const current = f.commit("fix: recent change", "new", [squash]);
  f.git("tag", "v1.0.1", current);
  const notes = f.notes("v1.0.1");
  assert.match(notes, /## Net file changes/u);
  assert.match(notes, /0 files added, 1 modified, 0 deleted, 0 changed type/u);
  assert.match(notes, /compare\/v1\.0\.0\.\.v1\.0\.1\n/u);
  assert.doesNotMatch(notes, /huge old feature|ship all old features|recent change|## Features/u);
});

test("net counts preserve unusual filenames without injecting Markdown", (t) => {
  const f = fixture(t);
  const previous = f.commit("feat: old", "old", [f.root]);
  f.git("tag", "v1.0.0", previous);
  const current = f.commit("feat: squash", "new", [f.root], "odd\n`[filename].txt");
  f.git("tag", "v1.0.1", current);
  const notes = f.notes("v1.0.1");
  assert.match(notes, /1 files added, 0 modified, 0 deleted, 0 changed type/u);
  assert.doesNotMatch(notes, /filename/u);
});

test("initial release alone includes full history and rejects invalid current releases", (t) => {
  const f = fixture(t);
  f.git("tag", "v1.0.0", f.root);
  assert.match(f.notes("v1.0.0"), /chore: initialize/u);
  assert.match(f.notes("v1.0.0"), /\/commits\/v1\.0\.0/u);
  for (const tag of [undefined, "v1.0", "v1.0.0-rc.1", "v01.0.0"]) {
    assert.throws(() => f.notes(tag), /strict stable version/u);
  }
  const other = f.commit("fix: untagged", "other", [f.root]);
  assert.throws(() => f.notes("v1.0.0", other), /does not match its tag/u);
});
