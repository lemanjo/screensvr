import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import main from "../.github/rulesets/main.json";
import tagCreation from "../.github/rulesets/release-tag-creation.json";
import tags from "../.github/rulesets/release-tags.json";

describe("solo-maintainer repository protections", () => {
  it("blocks main deletion and force pushes without an everyday bypass", () => {
    expect(main.enforcement).toBe("active");
    expect(main.bypass_actors).toEqual([]);
    expect(main.conditions.ref_name.include).toEqual(["refs/heads/main"]);
    expect(main.rules).toEqual(
      expect.arrayContaining([
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
      ]),
    );
  });

  it("requires all three CI checks from the GitHub Actions integration", () => {
    expect(main.rules).toContainEqual({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: "test", integration_id: 15368 },
          { context: "security", integration_id: 15368 },
          { context: "container", integration_id: 15368 },
        ],
      },
    });
  });

  it("does not let the administrator's tag-creation bypass permit tag replacement", () => {
    expect(tagCreation.conditions).toEqual(tags.conditions);
    expect(tagCreation.rules).toEqual([{ type: "creation" }]);
    expect(tagCreation.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
    expect(tags.bypass_actors).toEqual([]);
    expect(tags.rules).toEqual([{ type: "update" }, { type: "deletion" }]);
  });
});

describe("workflow trust boundaries", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = readdirSync(directory).filter((name) =>
    /\.ya?ml$/.test(name),
  );

  it.each(workflows)(
    "%s pins all external actions to full commit SHAs",
    (name) => {
      const workflow = readFileSync(new URL(name, directory), "utf8");
      const references = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)];
      expect(references.length).toBeGreaterThan(0);
      for (const [, reference] of references) {
        if (!reference.startsWith("./")) {
          expect(reference).toMatch(/@[0-9a-f]{40}$/);
        }
      }
    },
  );

  it("keeps registry write and OIDC out of the reusable CI workflow", () => {
    const ci = readFileSync(new URL("ci.yaml", directory), "utf8");
    expect(ci).not.toMatch(
      /packages:\s*write|id-token:\s*write|secrets:\s*inherit/,
    );
    expect(ci).not.toContain("pull_request_target:");
    expect(ci).toContain('DOCKER_BUILD_RECORD_UPLOAD: "false"');
  });

  it("archives the loaded image without requiring a Docker tar exporter", () => {
    const ci = readFileSync(new URL("ci.yaml", directory), "utf8");
    expect(ci).toContain("driver: docker");
    expect(ci).toContain(
      'docker image save --output "$RUNNER_TEMP/image.tar" screensvr:release',
    );
    expect(ci).not.toContain("outputs: type=docker");
  });

  it("does not check out or rebuild application code in the publisher", () => {
    const release = readFileSync(new URL("release.yaml", directory), "utf8");
    const publisher = release.split(/^ {2}publish:\s*$/m)[1];
    expect(publisher).toBeDefined();
    expect(publisher).toContain("environment: release");
    expect(publisher).toContain("packages: write");
    expect(publisher).toContain("digest-mismatch: error");
    expect(publisher).not.toMatch(
      /uses:\s*actions\/checkout|uses:\s*docker\/build-push-action/,
    );
    expect(publisher).not.toMatch(/^\s+run:.*(?:npm|npx)\s/m);
  });

  it("requires SHA enforcement to check the remote workflows first", () => {
    const script = readFileSync(
      fileURLToPath(
        new URL("../.github/scripts/configure-repository.py", import.meta.url),
      ),
      "utf8",
    );
    expect(script).toContain("if not remote_actions_are_pinned(");
    expect(script).toContain(
      'parser.error("Merge the pinned workflows before using --finalize.")',
    );
  });
});
