import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function previousStableTag(tags, currentTag) {
  const current = currentTag?.match(STABLE_TAG)?.slice(1).map(BigInt);
  if (!current) throw new Error("Release tag must be a strict stable version: vMAJOR.MINOR.PATCH");
  let previous = null;
  for (const tag of tags) {
    const version = tag.match(STABLE_TAG)?.slice(1).map(BigInt);
    if (!version || compareVersions(version, current) >= 0) continue;
    if (!previous || compareVersions(version, previous.version) > 0) previous = { tag, version };
  }
  return previous?.tag ?? null;
}

export function generateReleaseNotes({ tag, revision = tag, repository, cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  if (!repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("A GitHub owner/repository is required");
  const previous = previousStableTag(git("tag", "--list").trim().split("\n"), tag);
  const currentCommit = git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim();
  const taggedCommit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`).trim();
  if (currentCommit !== taggedCommit) throw new Error("Release revision does not match its tag");
  const baseUrl = `https://github.com/${repository}`;
  const notes = [];
  let baseline = null;
  let divergent = false;
  if (previous) {
    baseline = git("rev-parse", "--verify", `refs/tags/${previous}^{commit}`).trim();
    try {
      git("merge-base", "--is-ancestor", baseline, currentCommit);
    } catch (error) {
      if (error.status !== 1) throw error;
      divergent = true;
      baseline = null;
    }
  }

  if (divergent) {
    // Two endpoints, not a merge-base diff: old feature commits must not look new.
    const statuses = git("diff", "--no-renames", "--name-status", "-z", `refs/tags/${previous}`, currentCommit, "--")
      .split("\0");
    const counts = { A: 0, M: 0, D: 0, T: 0 };
    for (let index = 0; index < statuses.length - 1; index += 2) counts[statuses[index]] += 1;
    notes.push(
      "## Net file changes",
      "",
      `The history of ${previous} is not an ancestor of ${tag}. This summary compares the two release trees directly; historical commit titles are omitted to avoid presenting previously shipped work as new.`,
      "",
      `- ${counts.A} files added, ${counts.M} modified, ${counts.D} deleted, ${counts.T} changed type.`,
      "",
    );
  } else {
    const groups = [
      { key: "feat", title: "Features", commits: [] },
      { key: "change", title: "Changes", commits: [] },
      { key: "fix", title: "Fixes", commits: [] },
      { key: "ci", title: "CI", commits: [] },
    ];
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const fields = git("log", "--first-parent", "-z", "--format=%s%x00%h", baseline ? `${baseline}..${currentCommit}` : currentCommit, "--")
      .split("\0");
    fields.pop(); // Remove only the record terminator; empty subjects are valid fields.
    for (let index = 0; index < fields.length; index += 2) {
      const subject = fields[index].trim() || "(no commit subject)";
      const hash = fields[index + 1].trim();
      const type = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:\s+/i)?.[1].toLowerCase();
      const key = ["feat", "fix", "ci"].includes(type) ? type : "change";
      byKey.get(key).commits.push(`- ${subject} (\`${hash}\`)`);
    }
    for (const group of groups) {
      if (group.commits.length === 0) continue;
      notes.push(`## ${group.title}`, "", ...group.commits, "");
    }
  }
  // GitHub's two-dot comparison shows the endpoint trees even across divergent histories.
  const changelogUrl = previous
    ? `${baseUrl}/compare/${previous}${divergent ? ".." : "..."}${tag}`
    : `${baseUrl}/commits/${tag}`;
  notes.push(`**${divergent ? "Release tree diff" : "Full changelog"}**: ${changelogUrl}`, "");
  return notes.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync("release-notes.md", generateReleaseNotes({
    tag: process.env.GITHUB_REF_NAME,
    revision: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  }));
}
