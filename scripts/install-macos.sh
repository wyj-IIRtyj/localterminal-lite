#!/usr/bin/env bash
set -euo pipefail

version="v1.0.0"
install_dir="${LOCALTERMINAL_LITE_HOME:-$HOME/LocalTerminal-Lite}"

if [[ -e "$install_dir" ]]; then
  echo "LocalTerminal Lite already exists at $install_dir"
  echo "Move that folder or set LOCALTERMINAL_LITE_HOME to a new location, then run this command again."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.com/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun was installed but is not on PATH. Open a new Terminal window and run the installer again."
  exit 1
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
curl -fsSL "https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/${version}.tar.gz" \
  | tar -xz -C "$temporary_dir"
source_dir="$(find "$temporary_dir" -mindepth 1 -maxdepth 1 -type d -name 'localterminal-lite-*' | head -n 1)"

if [[ -z "$source_dir" ]]; then
  echo "The LocalTerminal Lite archive could not be unpacked."
  exit 1
fi

mv "$source_dir" "$install_dir"
cd "$install_dir"
bun install --frozen-lockfile
exec bun run dev
