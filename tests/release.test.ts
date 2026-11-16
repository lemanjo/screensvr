import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateRelease } from "../.github/scripts/validate-release";

const sha = "a".repeat(40);
const published = {
  action: "published",
  release: {
    tag_name: "v0.1.0",
    draft: false,
    prerelease: false,
    immutable: true,
  },
};

describe("release validation", () => {
  it("derives the image from the repository and keeps the exact commit", () => {
    expect(
      validateRelease(published, "Lemanjo/screensvr", sha, "0.1.0"),
    ).toEqual({
      version: "v0.1.0",
      image: "ghcr.io/lemanjo/screensvr",
      sha,
    });
  });

  it("accepts correctly marked SemVer prereleases", () => {
    const event = {
      ...published,
      release: {
        ...published.release,
        tag_name: "v0.2.0-rc.1",
        prerelease: true,
      },
    };
    expect(
      validateRelease(event, "lemanjo/screensvr", sha, "0.2.0-rc.1").version,
    ).toBe("v0.2.0-rc.1");
  });

  it.each([
    "main",
    "v01.0.0",
    "v0.1",
    "v0.1.0\n",
    "v0.1.0+build",
    "v0.1.0-01",
    "v0.1.0-rc/1",
    "v0.1.0-$(id)",
    "v0.1.0-" + "a".repeat(128),
  ])("rejects invalid or unsafe tag %j", (tag) => {
    expect(() =>
      validateRelease(
        { ...published, release: { ...published.release, tag_name: tag } },
        "lemanjo/screensvr",
        sha,
        tag.slice(1),
      ),
    ).toThrow();
  });

  it("rejects a release with a mismatched package version", () => {
    expect(() =>
      validateRelease(published, "lemanjo/screensvr", sha, "0.2.0"),
    ).toThrow(/package.json/);
  });

  it.each([
    { ...published, action: "created" },
    { ...published, release: { ...published.release, draft: true } },
    { ...published, release: { ...published.release, immutable: false } },
    { ...published, release: { ...published.release, prerelease: true } },
  ])(
    "rejects draft, mutable, incorrectly marked, and non-published releases",
    (event) => {
      expect(() =>
        validateRelease(event, "lemanjo/screensvr", sha, "0.1.0"),
      ).toThrow();
    },
  );

  it.each(["main", "a".repeat(39), sha + "\n", sha + "\ninjected=1"])(
    "rejects non-commit and output-injection SHA values",
    (value) => {
      expect(() =>
        validateRelease(published, "lemanjo/screensvr", value, "0.1.0"),
      ).toThrow(/SHA/);
    },
  );

  it.each(["owner/repo\n", "owner/repo\ninjected=1"])(
    "rejects repository output injection",
    (repository) => {
      expect(() =>
        validateRelease(published, repository, sha, "0.1.0"),
      ).toThrow(/repository/);
    },
  );
});

describe("release Git validation", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "screensvr-release-test-"));
    directories.push(directory);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Release test",
          "-c",
          "user.email=release-test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    git("init", "--initial-branch=main");
    writeFileSync(join(directory, "package.json"), '{"version":"0.1.0"}');
    git("add", "package.json");
    git("commit", "-m", "Initial release fixture");
    const main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    writeFileSync(join(directory, "event.json"), JSON.stringify(published));
    return {
      git,
      directory,
      main,
      run: (eventSha: string) =>
        spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "../.github/scripts/validate-release.ts",
                import.meta.url,
              ),
            ),
          ],
          {
            cwd: directory,
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_REPOSITORY: "lemanjo/screensvr",
              GITHUB_SHA: eventSha,
              GITHUB_EVENT_PATH: join(directory, "event.json"),
              GITHUB_OUTPUT: join(directory, "outputs"),
            },
          },
        ),
    };
  }

  it("accepts an annotated release tag on main", () => {
    const release = fixture();
    release.git("tag", "-a", "v0.1.0", "-m", "Release");
    const result = release.run(release.main);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(release.directory, "outputs"), "utf8")).toBe(
      `version=v0.1.0\nimage=ghcr.io/lemanjo/screensvr\nsha=${release.main}\n`,
    );
  });

  it("rejects a tagged commit outside main, regardless of release labels", () => {
    const release = fixture();
    release.git("checkout", "-b", "not-main");
    writeFileSync(join(release.directory, "unreviewed"), "not merged");
    release.git("add", "unreviewed");
    release.git("commit", "-m", "Not on main");
    release.git("tag", "v0.1.0");
    expect(release.run(release.git("rev-parse", "HEAD")).status).not.toBe(0);
  });

  it("rejects an event SHA that differs from the tagged checkout", () => {
    const release = fixture();
    release.git("tag", "v0.1.0");
    const result = release.run("b".repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must match the event SHA");
  });
});
