# Repository and release security

This public repository uses standard GitHub-hosted runners, free security
features, and GHCR. No personal access token, registry password, signing key,
self-hosted runner, or second maintainer is needed.

## GitHub settings

The repository settings are repeatable with an administrator-authenticated
GitHub CLI. Review the dry run before applying:

```sh
python3 .github/scripts/configure-repository.py
python3 .github/scripts/configure-repository.py --apply
```

This configures:

- `main`: pull requests, up-to-date passing `test`, `security`, and `container`
  checks from GitHub Actions; no force pushes or deletion; zero required review
  approvals and no administrator bypass.
- `v*` tags: only repository administrators may create them; **nobody** may
  update or delete them. Separate creation/immutability rulesets prevent the
  administrator's creation bypass from permitting tag replacement.
- Immutable releases and private vulnerability reporting.
- Dependabot alerts/security updates, secret scanning, and push protection.
- Read-only default workflow permissions, no automated PR approvals, an explicit
  action allowlist, and approval for all outside-contributor workflow runs.
- A `release` environment accepting only `v*` **tags**, not branches. It has no
  reviewer requirement, self-review restriction, secrets, or administrator bypass.

The allowlist initially accepts existing version references so the current
remote CI is not broken before this change merges. After the pinned workflows
are on `main`, enforce full commit-SHA pinning:

```sh
python3 .github/scripts/configure-repository.py --apply --finalize
```

The script refuses to enable SHA enforcement while remote workflows contain
unpinned actions. Its mutations are explicit; unrelated rulesets are preserved.
CodeQL uses the checked-in advanced workflow, **not** GitHub's default setup.
It starts scanning JavaScript/TypeScript and Actions when that workflow merges.

GitHub settings are not versioned automatically. The ruleset JSON files and
configuration script document the intended state. Account passkeys/2FA,
recovery codes, and account access must be managed separately in GitHub settings.
If emergency recovery is necessary, deliberately edit a ruleset in Settings;
there is no permanent everyday bypass.

## Pull requests and automated maintenance

You can create, inspect, and merge your own PR once checks pass. There is no
second-person approval requirement. `CODEOWNERS` provides ownership/notifications,
not a blocking review. Review external PRs carefully, especially changes to
workflows, release scripts, dependency files, and security-tool checksums.

CI runs application/browser tests, npm audits for both lockfiles, a redacted
Gitleaks scan over fetched Git history, actionlint/ShellCheck, a production image
build, a Trivy scan, and a container health/non-root smoke test. Fixable HIGH and
CRITICAL container vulnerabilities fail CI. Unfixed findings are not a release
gate; monitor them and update the base image when fixes become available.
CI and CodeQL also run weekly to catch newly disclosed issues.

Dependabot opens reviewed update PRs for npm, Actions (including SHA pins), and
Docker image versions/digests. Security-tool binaries in
`.github/scripts/install-security-tools.sh` are pinned by version and SHA-256;
review their upstream releases and refresh both values together. No downloaded
installer scripts are executed.

The Node base image is digest-pinned. The runtime removes bundled package
managers after installing production dependencies: npm, Yarn, and Corepack are
not needed to start the server and can otherwise introduce unrelated vulnerable
dependencies into the shipped image.

To run the same scanners locally on Linux x86_64:

```sh
bash .github/scripts/install-security-tools.sh gitleaks actionlint trivy
"${XDG_CACHE_HOME:-$HOME/.cache}/screensvr-security-tools/bin/gitleaks" git --redact --no-banner --log-opts=--all .
"${XDG_CACHE_HOME:-$HOME/.cache}/screensvr-security-tools/bin/actionlint"
shellcheck .github/scripts/*.sh
```

The installer uses `$RUNNER_TEMP` on Actions; `SECURITY_TOOLS_DIR` can override
the local installation directory. Secret scanners are not proof that history is
secret-free. Rotate exposed credentials immediately; ignore rules only prevent
accidental additions.

## Publish a release

1. Update `package.json` and its lockfile to the desired SemVer version, for
   example `0.1.0` or `0.2.0-rc.1`. Merge the change through a passing PR.
2. In GitHub Releases, create a draft with the matching `v`-prefixed tag on a
   commit from `main`. Attach any GitHub release assets **before** publication:
   immutable releases cannot accept new assets afterward.
3. Mark prereleases consistently with their version suffix. Publish the release
   when ready. This is the deliberate approval step; no second approval is needed.
4. The release workflow validates immutability, the version, the exact checked-out
   commit/tag, and actual Git ancestry on `main`. It does not trust the release's
   `target_commitish` label.
5. Read-only jobs rerun all checks and build/scan/smoke-test the image. A one-day
   artifact transfers the image and CycloneDX SBOM to the publishing job.
6. The environment-restricted publisher verifies the archive checksum and
   downloads only this run's artifact. It does not check out the repository,
   install dependencies, or rebuild. Only this job receives registry write,
   attestation, and OIDC permissions.
7. The publisher uses its short-lived `GITHUB_TOKEN` to push
   `ghcr.io/lemanjo/screensvr:vVERSION` and `sha-COMMIT`, then publishes provenance
   and SBOM attestations. It refuses to replace an existing version tag.
   `latest` changes only for GitHub's current latest stable release, and only
   after the attestations succeed.

The initial published platform is **linux/amd64**. Other architectures can build
from source; do not advertise multi-architecture published images until their
build, scan, and smoke-test matrix has been added.

After the **first** successful publish, open the container package's settings
and change its visibility to **public**. GHCR packages default to private even
when the source repository is public. Confirm an unauthenticated pull works.
Keep the package linked to this repository and its Actions access restricted
to this repository; do not add PAT-based publishing credentials.

Inspect the run summary for the image digest and verification command. Test:

- A fork PR has no publishing job, secrets, OIDC, or registry-write permission.
- Invalid, non-immutable, off-main, or mismatched-version releases fail before
  building; failed checks/scans never reach publishing.
- A prerelease cannot update `latest`, and rerunning a published version cannot
  overwrite its image.
- The published image can be pulled anonymously after making the package public,
  and its attestations verify against this repository.

No release or container is published merely by merging this setup. The first
real release is also the end-to-end verification of the publisher.

## Verification, failures, and cost

Use image digests for fixed deployments. GitHub release immutability protects
Git tags and release assets, **not** mutable GHCR tags such as `latest`.
An attestation proves provenance, not the absence of vulnerabilities.

If a release fails before publishing, inspect the error and rerun it once fixed.
If publishing partially succeeds, do not delete or replace the version. Publish
a new patch version and explain the failure in the release notes; the existing
version may not have complete attestations or an updated `latest` tag.

Standard hosted-runner compute is free for public repositories, and GHCR storage
and bandwidth are currently free. Workflow artifacts have **one-day retention**,
and automatic Docker build-record uploads are disabled. No image build caches
are persisted; keep Actions cache storage at the included limit and do not enable
larger paid runners. Monitor account artifact-storage usage and spending limits,
especially if many releases or failed browser tests run close together.
