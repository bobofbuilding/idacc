#!/bin/sh
# idctl installer.
#   curl -fsSL https://<host>/install.sh | sh
# Downloads the right standalone binary for this OS/arch, verifies its
# checksum, installs it to ~/.local/bin (no root), and clears macOS quarantine.
set -eu

REPO="${IDCTL_REPO:-bobofbuilding/idacc}"  # override with IDCTL_REPO=owner/repo
PREFIX="${IDCTL_PREFIX:-$HOME/.local/bin}"        # override with IDCTL_PREFIX=/usr/local/bin
BASE="https://github.com/$REPO/releases/latest/download"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) plat=darwin ;;
  Linux)  plat=linux ;;
  *) echo "idctl: unsupported OS '$os' (macOS/Linux only)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64)  cpu=x64 ;;
  *) echo "idctl: unsupported arch '$arch'"; exit 1 ;;
esac

asset="idctl-${plat}-${cpu}"
# Alpine / musl libc auto-detect.
if [ "$plat" = linux ] && (ldd --version 2>&1 | grep -qi musl); then
  asset="${asset}-musl"
fi

echo "idctl: installing $asset → $PREFIX/idctl"
mkdir -p "$PREFIX"
tmp="$(mktemp)"; sums="$(mktemp)"
trap 'rm -f "$tmp" "$sums"' EXIT

curl -fsSL "$BASE/$asset" -o "$tmp"

# Best-effort checksum verification.
if curl -fsSL "$BASE/SHASUMS256.txt" -o "$sums" 2>/dev/null; then
  want="$(grep " $asset\$" "$sums" 2>/dev/null | awk '{print $1}')"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp" | awk '{print $1}')";
    else got="$(shasum -a 256 "$tmp" | awk '{print $1}')"; fi
    if [ "$want" != "$got" ]; then echo "idctl: checksum mismatch — aborting"; exit 1; fi
    echo "idctl: checksum OK"
  fi
fi

install -m 0755 "$tmp" "$PREFIX/idctl"
# macOS: drop the quarantine xattr so Gatekeeper allows the ad-hoc-signed binary.
[ "$plat" = darwin ] && xattr -dr com.apple.quarantine "$PREFIX/idctl" 2>/dev/null || true

echo "idctl: installed."
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "idctl: add $PREFIX to your PATH, e.g.:  echo 'export PATH=\"$PREFIX:\$PATH\"' >> ~/.zshrc" ;;
esac
echo "Run:  idctl --help"
