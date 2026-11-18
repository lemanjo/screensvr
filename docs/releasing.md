# Releasing screensvr

This guide is for maintainers. Publishing a GitHub release is the deliberate
approval to build, check, and publish its container image. Merging a pull request
or creating a tag alone does not publish a container.

The workflow uses GitHub-hosted runners, GHCR, short-lived GitHub credentials,
and attestations. It needs no personal access token, registry password, signing
key, self-hosted runner, or second maintainer.

## Before a release

- Confirm the [repository settings](#repository-settings) and immutable releases
  are enabled.
- Update `package.json` and `package-lock.json` to the intended version, such as
  `1.0.0`. Keep any user-visible application version labels and documentation
  examples consistent. The application version, face package versions, and
  manifest format identifier are separate values.
- Run the checks in [Development](development.md#run-checks), review security
  findings, and complete [real-service/device checks](development.md#integration-and-device-testing).
- Check the security policy for any time-limited advisory acceptance. Do not
  bypass its scope or silently extend its deadline.
- Verify first-run setup, an upgrade from the previous supported release,
  complete-directory backup/restore, and integration-key recovery.
- Prepare release notes covering features, requirements, known limits, and
  upgrade/rollback instructions. Documentation targeting a new image tag can
  land before publication, but that tag is pullable only after publishing succeeds.

Merge version, documentation, and release-preparation changes through a passing
PR before publishing.

## Publish a release

1. In GitHub Releases, create a draft using the matching `v`-prefixed version,
   such as **`v1.0.0`**, on a commit from `main`.
2. Add notes and any GitHub release assets **before publication**. Immutable
   releases cannot accept new assets afterward.
3. If the version has a prerelease suffix, such as `1.1.0-rc.1`, mark it as a
   prerelease. Publish when ready; no second approval is required.
4. Watch the **Release container** workflow. It validates release immutability,
   version/tag equality, the exact checked-out commit, and actual ancestry on
   `main`. The release's `target_commitish` label is not proof of ancestry.
5. Wait for the test, security, container build/scan/smoke-test, and publishing
   jobs to finish. A release page can exist before its image is available.
6. Check the run summary for the image digest and verification command.
7. Confirm an anonymous pull and provenance verification succeed, then check the
   running release with a fresh data directory and a restored test backup.

Published images support **linux/amd64**. Do not advertise multi-architecture
images until the build, scan, and smoke-test matrix supports them.

### What the workflow publishes

Read-only jobs rerun CI and produce the scanned image plus a CycloneDX SBOM.
A one-day artifact transfers them to the environment-restricted publisher,
which verifies the archive checksum. The publisher does not check out source,
install dependencies, or rebuild.

Only that job receives registry-write, attestation, and OIDC permissions.
It uses the short-lived `GITHUB_TOKEN` to publish:

- `ghcr.io/lemanjo/screensvr:vVERSION`
- `ghcr.io/lemanjo/screensvr:sha-COMMIT`
- Build provenance and SBOM attestations

An existing version tag cannot be replaced. `latest` updates only for GitHub's
current latest stable release and only after attestations succeed. Prereleases
never update it.

### First package publication

After the first successful push, change the GHCR package visibility to **public**.
Packages default to private even when their source repository is public.
Confirm that unauthenticated pulls work.

Keep the package linked to this repository with Actions access restricted to
this repository. Do not add PAT-based publishing credentials.

## Verification and failure recovery

Use the exact digest from the workflow summary for fixed deployments. See
[image verification](deployment.md#verify-a-release-image) for the CLI command.
GitHub release immutability protects Git tags and release assets, **not** mutable
GHCR tags such as `latest`. Attestations prove provenance, not the absence of
vulnerabilities.

When validating publishing changes, confirm:

- Fork PRs receive no publishing job, secrets, OIDC, or registry-write permission.
- Non-immutable, invalid, off-main, or mismatched-version releases fail before building.
- Failed checks/scans never reach publishing.
- Prereleases cannot update `latest`, and reruns cannot replace published versions.
- Public images pull anonymously and their attestations verify against this repo.

If failure occurs **before publishing**, inspect the error and rerun once fixed.
If publishing partially succeeds, do not delete or replace the version. Publish
a new patch release and explain the failure in its notes; the existing version
may lack complete attestations or an updated `latest`.

## Repository settings

Use an administrator-authenticated GitHub CLI. Review the dry run before
changing remote settings:

```sh
python3 .github/scripts/configure-repository.py
python3 .github/scripts/configure-repository.py --apply
```

The script configures:

- `main` requires PRs and up-to-date passing `test`, `security`, and `container`
  checks, with no force pushes, deletion, or administrator bypass. Zero review
  approvals are required for solo maintenance.
- Only repository administrators may create `v*` tags; nobody may update or
  delete them. Separate creation/immutability rulesets prevent creation bypass
  from permitting replacement.
- Immutable releases, private vulnerability reporting, Dependabot alerts/updates,
  secret scanning, and push protection.
- Read-only default workflow permissions, no automated PR approvals, an action
  allowlist, and approval for all outside-contributor workflow runs.
- A `release` environment restricted to `v*` tags, not branches, with no reviewer
  requirement, self-review restriction, secrets, or administrator bypass.

For a new setup, the allowlist first permits existing version references so
remote CI is not broken before SHA-pinned workflows land. Once they are on
`main`, finalize full commit-SHA enforcement:

```sh
python3 .github/scripts/configure-repository.py --apply --finalize
```

The script refuses SHA enforcement while remote workflows contain unpinned
actions and preserves unrelated rulesets. CodeQL uses the checked-in advanced
workflow, not GitHub's default setup.

GitHub settings are not automatically versioned. The ruleset JSON files and
script record the intended state. Manage account passkeys/2FA, recovery codes,
and account access separately. Emergency recovery requires deliberately editing
a ruleset; there is no permanent everyday bypass.

## Automated checks and maintenance

Maintainers can create, inspect, and merge their own PRs after checks pass.
`CODEOWNERS` provides notifications, not a blocking review. Carefully review
external changes to workflows, scripts, lockfiles, and security-tool checksums.

CI runs application/browser tests, dependency audits for both lockfiles, a
redacted Gitleaks scan of fetched Git history, actionlint/ShellCheck, a production
image build, Trivy, and a health/non-root smoke test. Fixable HIGH/CRITICAL
container vulnerabilities block CI. Unfixed findings are not a release gate;
monitor them and update the base image when fixes appear. CI and CodeQL also
run weekly.

Dependabot proposes npm, Actions/SHA-pin, and Docker image updates. Security
tool versions and SHA-256 checksums are pinned in
`.github/scripts/install-security-tools.sh`; review and update both together.
Downloaded installer scripts are not executed.

The Node base image is digest-pinned. The runtime removes npm, Yarn, and
Corepack after installing production dependencies to avoid shipping unnecessary
package managers.

To run the security checks locally on Linux x86_64:

```sh
bash .github/scripts/install-security-tools.sh gitleaks actionlint trivy
"${XDG_CACHE_HOME:-$HOME/.cache}/screensvr-security-tools/bin/gitleaks" git --redact --no-banner --log-opts=--all .
"${XDG_CACHE_HOME:-$HOME/.cache}/screensvr-security-tools/bin/actionlint"
shellcheck .github/scripts/*.sh
node .github/scripts/audit-dependencies.ts
```

The installer uses `$RUNNER_TEMP` on Actions; `SECURITY_TOOLS_DIR` overrides its
local directory. Scanners cannot prove history is secret-free. Rotate exposed
credentials; ignore rules do not revoke them.

### Resource usage

The setup is intended for GitHub's standard public-repository allowances.
Check current GitHub pricing and account limits rather than assuming unlimited
free compute, storage, or bandwidth.

Workflow artifacts have **one-day retention**, automatic Docker build-record
uploads are disabled, and image build caches are not persisted. Keep Actions
cache storage bounded and avoid larger paid runners without an explicit decision.
Monitor artifact storage and spending limits, especially around failed or
frequent release runs.
