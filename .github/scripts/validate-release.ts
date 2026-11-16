import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type ReleaseEvent = {
  action: string;
  release: {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    immutable: boolean;
  };
};

export function validateRelease(
  event: ReleaseEvent,
  repository: string,
  sha: string,
  packageVersion: string,
) {
  if (event.action !== "published" || event.release.draft) {
    throw new Error("Only published releases may publish containers.");
  }
  if (!event.release.immutable) {
    throw new Error("Enable immutable releases before publishing.");
  }
  const version = event.release.tag_name;
  // Restrict both Git refs and Docker tags, including SemVer prerelease identifiers.
  const integer = "(?:0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const semver = new RegExp(
    `^v${integer}\\.${integer}\\.${integer}(?:-${identifier}(?:\\.${identifier})*)?$`,
  );
  if (
    !semver.test(version) ||
    version.trim() !== version ||
    version.length > 128
  ) {
    throw new Error(
      "Release tags must be Docker-compatible SemVer, e.g. v0.1.0.",
    );
  }
  if (version.slice(1) !== packageVersion) {
    throw new Error("The release tag must match package.json's version.");
  }
  if (event.release.prerelease !== version.includes("-")) {
    throw new Error(
      "The prerelease flag must match the version's prerelease suffix.",
    );
  }
  if (sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("The release must resolve to an exact commit SHA.");
  }
  if (
    repository.trim() !== repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error("Invalid GitHub repository.");
  }
  return { version, image: `ghcr.io/${repository.toLowerCase()}`, sha };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"),
  ) as ReleaseEvent;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };
  const metadata = validateRelease(
    event,
    process.env.GITHUB_REPOSITORY!,
    process.env.GITHUB_SHA!,
    pkg.version,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const taggedCommit = git(
    "rev-parse",
    "--verify",
    `refs/tags/${metadata.version}^{commit}`,
  );
  if (
    taggedCommit !== metadata.sha ||
    git("rev-parse", "HEAD") !== metadata.sha
  ) {
    throw new Error(
      "The checkout and immutable release tag must match the event SHA.",
    );
  }
  // target_commitish is not proof of ancestry; inspect the actual Git graph.
  git("merge-base", "--is-ancestor", metadata.sha, "refs/remotes/origin/main");
  for (const [key, value] of Object.entries(metadata)) {
    appendFileSync(process.env.GITHUB_OUTPUT!, `${key}=${value}\n`);
  }
}
