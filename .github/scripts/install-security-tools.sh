#!/usr/bin/env bash
set -euo pipefail

# Install only checksum-verified upstream release binaries; never curl | sh.
# Review versions and checksums together when updating these tools.
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "These pinned security tools require Linux x86_64." >&2
  exit 1
fi

tools_dir="${SECURITY_TOOLS_DIR:-${RUNNER_TEMP:-${XDG_CACHE_HOME:-$HOME/.cache}}/screensvr-security-tools}"
mkdir -p "$tools_dir/bin"
temp_dir=$(mktemp -d "$tools_dir/download.XXXXXXXX")
trap 'rm -rf "$temp_dir"' EXIT

for tool in "$@"; do
  case "$tool" in
    gitleaks)
      repository=gitleaks/gitleaks
      version=8.30.1
      archive="gitleaks_${version}_linux_x64.tar.gz"
      checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
      ;;
    trivy)
      repository=aquasecurity/trivy
      version=0.76.2
      archive="trivy_${version}_Linux-64bit.tar.gz"
      checksum=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
      ;;
    actionlint)
      repository=rhysd/actionlint
      version=1.7.12
      archive="actionlint_${version}_linux_amd64.tar.gz"
      checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
      ;;
    *)
      echo "Unknown security tool: $tool" >&2
      exit 1
      ;;
  esac

  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --proto-redir '=https' \
    "https://github.com/$repository/releases/download/v$version/$archive" \
    --output "$temp_dir/$archive"
  printf '%s  %s\n' "$checksum" "$temp_dir/$archive" | sha256sum --check --strict
  tar -xzf "$temp_dir/$archive" -C "$tools_dir/bin" "$tool"
  chmod 755 "$tools_dir/bin/$tool"
done

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$tools_dir/bin" >> "$GITHUB_PATH"
fi
echo "Security tools installed in $tools_dir/bin"
