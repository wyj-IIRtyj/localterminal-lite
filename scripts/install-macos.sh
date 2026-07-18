#!/usr/bin/env bash
set -euo pipefail

version="v1.0.1"
install_dir="${LOCALTERMINAL_LITE_HOME:-$HOME/LocalTerminal-Lite}"
launcher_dir="${LOCALTERMINAL_LITE_BIN_DIR:-$HOME/.local/bin}"
archive_url="${LOCALTERMINAL_LITE_ARCHIVE_URL:-https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/${version}.tar.gz}"

reuse_existing=0
if [[ -e "$install_dir" ]]; then
  if [[ -f "$install_dir/package.json" && -f "$install_dir/src/cli.ts" ]] \
    && grep -Eq '"name"[[:space:]]*:[[:space:]]*"localterminal-mcp-lite"' "$install_dir/package.json"; then
    reuse_existing=1
    echo "Reusing the existing LocalTerminal Lite installation at $install_dir"
  else
    echo "The target exists but is not a LocalTerminal Lite installation: $install_dir"
    echo "Move that path or set LOCALTERMINAL_LITE_HOME to a different location."
    exit 1
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.com/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! bun_path="$(command -v bun)" || [[ ! -x "$bun_path" ]]; then
  echo "Bun could not be installed or located."
  exit 1
fi

if [[ "$reuse_existing" == "0" ]]; then
  temporary_dir="$(mktemp -d)"
  trap 'rm -rf "$temporary_dir"' EXIT
  curl -fsSL "$archive_url" \
    | tar -xz -C "$temporary_dir"
  source_dir="$(find "$temporary_dir" -mindepth 1 -maxdepth 1 -type d -name 'localterminal-lite-*' | head -n 1)"

  if [[ -z "$source_dir" ]]; then
    echo "The LocalTerminal Lite archive could not be unpacked."
    exit 1
  fi

  mv "$source_dir" "$install_dir"
fi
cd "$install_dir"
"$bun_path" install --frozen-lockfile

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
  local profile_file="$1"
  local escaped_dir path_line
  printf -v escaped_dir '%q' "$launcher_dir"
  path_line="export PATH=${escaped_dir}:\$PATH"
  if [[ -f "$profile_file" ]] && grep -Fqx "$path_line" "$profile_file"; then
    return
  fi
  printf '\n# LocalTerminal Lite command\n%s\n' "$path_line" >> "$profile_file"
}

case "$(basename "${SHELL:-sh}")" in
  zsh)
    add_launcher_to_path "$HOME/.zprofile"
    add_launcher_to_path "$HOME/.zshrc"
    ;;
  bash)
    add_launcher_to_path "$HOME/.bash_profile"
    add_launcher_to_path "$HOME/.bashrc"
    ;;
  *)
    add_launcher_to_path "$HOME/.profile"
    ;;
esac

export PATH="$launcher_dir:$PATH"
echo "Installed the global command: localterminal-lite"
echo "In future Terminal windows, start Lite by running: localterminal-lite"
if [[ "${LOCALTERMINAL_LITE_INSTALL_ONLY:-0}" == "1" ]]; then
  exit 0
fi
exec "$launcher_path"
