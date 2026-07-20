#!/usr/bin/env bash
set -euo pipefail

version="${LOCALTERMINAL_LITE_VERSION:-v1.1.0}"
repository="wyj-IIRtyj/localterminal-lite"
install_dir="${LOCALTERMINAL_LITE_HOME:-$HOME/LocalTerminal-Lite}"
launcher_dir="${LOCALTERMINAL_LITE_BIN_DIR:-$HOME/.local/bin}"

case "$(uname -m)" in
  arm64|aarch64) platform="linux-arm64" ;;
  x86_64|amd64) platform="linux-x64" ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="localterminal-lite-${platform}.tar.gz"
asset_url="${LOCALTERMINAL_LITE_ASSET_URL:-https://github.com/${repository}/releases/download/${version}/${asset}}"
checksum_url="${LOCALTERMINAL_LITE_CHECKSUM_URL:-${asset_url}.sha256}"
temporary_dir="$(mktemp -d)"
backup_dir=""
migrating_legacy=0
committed=0

cleanup() {
  local code=$?
  if [[ "$code" != "0" && "$committed" != "1" && "$migrating_legacy" == "1" ]]; then
    rm -rf "$install_dir"
    [[ -n "$backup_dir" && -d "$backup_dir" ]] && mv "$backup_dir" "$install_dir" || true
  fi
  [[ "$committed" == "1" && -n "$backup_dir" && -d "$backup_dir" ]] && rm -rf "$backup_dir"
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

is_binary_layout() { [[ -d "$install_dir/releases" && -f "$install_dir/current" ]]; }
is_legacy_layout() {
  [[ -f "$install_dir/package.json" && -f "$install_dir/src/cli.ts" ]] \
    && grep -Eq '"name"[[:space:]]*:[[:space:]]*"localterminal-mcp-lite"' "$install_dir/package.json"
}

if [[ -e "$install_dir" ]]; then
  if [[ -d "$install_dir/.git" && "${LOCALTERMINAL_LITE_ALLOW_SOURCE_UPDATE:-0}" != "1" ]]; then
    echo "Refusing to overwrite a Git source checkout: $install_dir" >&2
    exit 1
  fi
  if ! is_binary_layout && ! is_legacy_layout; then
    echo "The target exists but is not a recognized LocalTerminal Lite installation: $install_dir" >&2
    exit 1
  fi
  if is_legacy_layout; then
    migrating_legacy=1
    backup_dir="${install_dir}.backup.$(date +%s)"
    mv "$install_dir" "$backup_dir"
  fi
fi

mkdir -p "$temporary_dir" "$install_dir/releases" "$launcher_dir"
curl -fL --retry 3 --retry-delay 1 "$asset_url" -o "$temporary_dir/$asset"
curl -fL --retry 3 --retry-delay 1 "$checksum_url" -o "$temporary_dir/$asset.sha256"
expected="$(awk '{print $1}' "$temporary_dir/$asset.sha256" | tr -d '\r\n')"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary_dir/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$temporary_dir/$asset" | awk '{print $1}')"
fi
[[ -n "$expected" && "$expected" == "$actual" ]] || { echo "SHA-256 verification failed for $asset" >&2; exit 1; }

tar -xzf "$temporary_dir/$asset" -C "$temporary_dir"
binary="$temporary_dir/localterminal-lite"
[[ -f "$binary" ]] || { echo "Release asset does not contain localterminal-lite" >&2; exit 1; }
chmod 755 "$binary"

release_dir="$install_dir/releases/$version"
release_staging="$install_dir/releases/.${version}.staging.$$"
rm -rf "$release_staging"
mkdir -p "$release_staging"
cp "$binary" "$release_staging/localterminal-lite"
chmod 755 "$release_staging/localterminal-lite"
rm -rf "$release_dir"
mv "$release_staging" "$release_dir"
printf '%s\n' "$version" > "$install_dir/current.tmp"
mv "$install_dir/current.tmp" "$install_dir/current"

launcher_path="$launcher_dir/localterminal-lite"
cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
root=$(printf '%q' "$install_dir")
version=\$(tr -d '\\r\\n' < "\$root/current")
exec "\$root/releases/\$version/localterminal-lite" "\$@"
EOF
chmod 755 "$launcher_path"

add_launcher_to_path() {
  local profile_file="$1" escaped_dir path_line
  printf -v escaped_dir '%q' "$launcher_dir"
  path_line="export PATH=${escaped_dir}:\$PATH"
  [[ -f "$profile_file" ]] && grep -Fqx "$path_line" "$profile_file" && return
  printf '\n# LocalTerminal Lite command\n%s\n' "$path_line" >> "$profile_file"
}
case "$(basename "${SHELL:-sh}")" in
  bash) add_launcher_to_path "$HOME/.bash_profile"; add_launcher_to_path "$HOME/.bashrc" ;;
  zsh) add_launcher_to_path "$HOME/.zprofile"; add_launcher_to_path "$HOME/.zshrc" ;;
  *) add_launcher_to_path "$HOME/.profile" ;;
esac

find "$install_dir/releases" -mindepth 1 -maxdepth 1 -type d -name 'v*' -print0 \
  | xargs -0 ls -1dt 2>/dev/null | tail -n +3 | while IFS= read -r old; do rm -rf "$old"; done || true

committed=1
export PATH="$launcher_dir:$PATH"
echo "Installed LocalTerminal Lite ${version}: $install_dir"
echo "User settings and workspace state were preserved."
echo "Start it with: localterminal-lite"
[[ "${LOCALTERMINAL_LITE_INSTALL_ONLY:-0}" == "1" ]] && exit 0
exec "$launcher_path"
