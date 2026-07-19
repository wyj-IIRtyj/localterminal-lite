#!/usr/bin/env bash
set -euo pipefail

version="v1.0.1"
install_dir="${LOCALTERMINAL_LITE_HOME:-$HOME/LocalTerminal-Lite}"
launcher_dir="${LOCALTERMINAL_LITE_BIN_DIR:-$HOME/.local/bin}"
archive_url="${LOCALTERMINAL_LITE_ARCHIVE_URL:-https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/${version}.tar.gz}"

temporary_dir="$(mktemp -d)"
backup_dir=""
committed=0
cleanup() {
  local code=$?
  if [[ "$code" != "0" && "$committed" != "1" ]]; then
    [[ -e "$install_dir" ]] && rm -rf "$install_dir"
    if [[ -n "$backup_dir" && -d "$backup_dir" ]]; then mv "$backup_dir" "$install_dir" || true; fi
  fi
  [[ "$committed" == "1" && -n "$backup_dir" ]] && rm -rf "$backup_dir"
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

if [[ -e "$install_dir" ]]; then
  if [[ ! -f "$install_dir/package.json" || ! -f "$install_dir/src/cli.ts" ]] \
    || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"localterminal-mcp-lite"' "$install_dir/package.json"; then
    echo "The target exists but is not a LocalTerminal Lite installation: $install_dir"
    exit 1
  fi
  if [[ -d "$install_dir/.git" && "${LOCALTERMINAL_LITE_ALLOW_SOURCE_UPDATE:-0}" != "1" ]]; then
    echo "Refusing to overwrite a Git source checkout: $install_dir"
    echo "Use git pull for source checkouts, or set LOCALTERMINAL_LITE_HOME to the release installation directory."
    exit 1
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.com/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
bun_path="$(command -v bun)"
[[ -x "$bun_path" ]] || { echo "Bun could not be installed or located."; exit 1; }

curl -fsSL "$archive_url" | tar -xz -C "$temporary_dir"
source_dir="$(find "$temporary_dir" -mindepth 1 -maxdepth 1 -type d -name 'localterminal-lite-*' | head -n 1)"
[[ -n "$source_dir" ]] || { echo "The LocalTerminal Lite archive could not be unpacked."; exit 1; }

cd "$source_dir"
"$bun_path" install --frozen-lockfile
"$bun_path" run typecheck

mkdir -p "$(dirname "$install_dir")"
if [[ -e "$install_dir" ]]; then
  backup_dir="${install_dir}.backup.$(date +%s)"
  mv "$install_dir" "$backup_dir"
fi
mv "$source_dir" "$install_dir"

mkdir -p "$launcher_dir"
launcher_path="$launcher_dir/localterminal-lite"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'cd %q\n' "$install_dir"
  printf 'exec %q run src/cli.ts "$@"\n' "$bun_path"
} > "$launcher_path"
chmod 755 "$launcher_path"

add_launcher_to_path() {
  local profile_file="$1" escaped_dir path_line
  printf -v escaped_dir '%q' "$launcher_dir"
  path_line="export PATH=${escaped_dir}:\$PATH"
  [[ -f "$profile_file" ]] && grep -Fqx "$path_line" "$profile_file" && return
  printf '\n# LocalTerminal Lite command\n%s\n' "$path_line" >> "$profile_file"
}
case "$(basename "${SHELL:-sh}")" in
  zsh) add_launcher_to_path "$HOME/.zprofile"; add_launcher_to_path "$HOME/.zshrc" ;;
  bash) add_launcher_to_path "$HOME/.bash_profile"; add_launcher_to_path "$HOME/.bashrc" ;;
  *) add_launcher_to_path "$HOME/.profile" ;;
esac

export PATH="$launcher_dir:$PATH"
committed=1
echo "Installed LocalTerminal Lite ${version}: $install_dir"
echo "Start it with: localterminal-lite"
[[ "${LOCALTERMINAL_LITE_INSTALL_ONLY:-0}" == "1" ]] && exit 0
exec "$launcher_path"
