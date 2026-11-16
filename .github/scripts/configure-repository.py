#!/usr/bin/env python3
"""Apply the public, solo-maintainer repository settings using an admin gh login."""

import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_ACTIONS = [
    "actions/checkout@*",
    "actions/setup-node@*",
    "actions/upload-artifact@*",
    "actions/download-artifact@*",
    "actions/attest@*",
    "docker/setup-buildx-action@*",
    "docker/build-push-action@*",
    "docker/login-action@*",
    "github/codeql-action/*@*",
]


def api(path, method="GET", data=None):
    command = ["gh", "api", path, "--method", method]
    if data is not None:
        command += ["--input", "-"]
    result = subprocess.run(
        command,
        input=json.dumps(data) if data is not None else None,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def remote_actions_are_pinned(repository, branch):
    files = api(f"repos/{repository}/contents/.github/workflows?ref={branch}")
    unpinned = []
    for file in files:
        if not file["name"].endswith((".yaml", ".yml")):
            continue
        contents = api(f"repos/{repository}/contents/{file['path']}?ref={branch}")
        workflow = base64.b64decode(contents["content"]).decode()
        references = re.findall(
            r"""^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)""",
            workflow,
            re.MULTILINE,
        )
        for reference in references:
            if reference.startswith("./"):
                continue
            if not re.search(r"@[0-9a-f]{40}$", reference):
                unpinned.append(f"{file['path']}: {reference}")
    if unpinned:
        print("Action SHA enforcement deferred until these remote references are pinned:")
        for reference in unpinned:
            print(f"  {reference}")
    return not unpinned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="lemanjo/screensvr")
    parser.add_argument("--apply", action="store_true", help="Modify GitHub settings")
    parser.add_argument(
        "--finalize",
        action="store_true",
        help="Also enforce SHA pins after pinned workflows have merged into main",
    )
    args = parser.parse_args()
    repo = api(f"repos/{args.repo}")
    if repo["visibility"] != "public" or repo["default_branch"] != "main":
        parser.error("This configuration requires a public repository with main as default.")
    if not repo["permissions"].get("admin"):
        parser.error("Repository administrator access is required.")

    errors = []

    def update(path, method="PUT", data=None):
        print(f"{'APPLY' if args.apply else 'PLAN'} {method} {path}")
        if not args.apply:
            return None
        try:
            return api(path, method, data)
        except subprocess.CalledProcessError as error:
            errors.append(path)
            print(error.stderr.strip(), file=sys.stderr)
            return None

    prefix = f"repos/{args.repo}"
    # A read-only default never prevents an individual trusted publishing job
    # from requesting packages:write.
    update(
        f"{prefix}/actions/permissions/workflow",
        data={"default_workflow_permissions": "read", "can_approve_pull_request_reviews": False},
    )
    update(
        f"{prefix}/actions/permissions/fork-pr-contributor-approval",
        data={"approval_policy": "all_external_contributors"},
    )
    permissions = api(f"{prefix}/actions/permissions")
    permissions = {
        "enabled": True,
        "allowed_actions": "selected",
        "sha_pinning_required": permissions.get("sha_pinning_required", False),
    }
    if args.finalize:
        if not remote_actions_are_pinned(args.repo, repo["default_branch"]):
            parser.error("Merge the pinned workflows before using --finalize.")
        permissions["sha_pinning_required"] = True
    update(f"{prefix}/actions/permissions", data=permissions)
    update(
        f"{prefix}/actions/permissions/selected-actions",
        data={
            "github_owned_allowed": False,
            "verified_allowed": False,
            "patterns_allowed": ALLOWED_ACTIONS,
        },
    )
    update(f"{prefix}/vulnerability-alerts")
    update(f"{prefix}/automated-security-fixes")
    update(
        prefix,
        method="PATCH",
        data={
            "security_and_analysis": {
                "secret_scanning": {"status": "enabled"},
                "secret_scanning_push_protection": {"status": "enabled"},
            }
        },
    )
    update(f"{prefix}/private-vulnerability-reporting")
    update(f"{prefix}/immutable-releases")

    existing_rulesets = api(f"{prefix}/rulesets")
    for path in sorted((ROOT / ".github/rulesets").glob("*.json")):
        ruleset = json.loads(path.read_text())
        existing = next(
            (item for item in existing_rulesets if item["name"] == ruleset["name"]
             and item["source_type"] == "Repository"),
            None,
        )
        if existing:
            update(f"{prefix}/rulesets/{existing['id']}", data=ruleset)
        else:
            update(f"{prefix}/rulesets", method="POST", data=ruleset)

    update(
        f"{prefix}/environments/release",
        data={
            "wait_timer": 0,
            "prevent_self_review": False,
            "reviewers": [],
            "can_admins_bypass": False,
            "deployment_branch_policy": {
                "protected_branches": False,
                "custom_branch_policies": True,
            },
        },
    )
    if args.apply:
        policies = api(f"{prefix}/environments/release/deployment-branch-policies")[
            "branch_policies"
        ]
        if any(item["name"] != "v*" or item["type"] != "tag" for item in policies):
            errors.append("Unexpected release environment branch/tag policies")
            print("Review unexpected environment policies manually; none were deleted.",
                  file=sys.stderr)
        if not any(item["name"] == "v*" and item["type"] == "tag" for item in policies):
            update(
                f"{prefix}/environments/release/deployment-branch-policies",
                method="POST",
                data={"name": "v*", "type": "tag"},
            )
    else:
        print("PLAN restrict the release environment to tags matching v*")
    if not args.finalize:
        print("After merging: rerun with --apply --finalize to enforce action SHA pins.")
    if errors:
        print("Some settings were not applied:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
