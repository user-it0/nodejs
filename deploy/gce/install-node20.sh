#!/usr/bin/env bash
set -euo pipefail

# Verified against Node.js official latest-v20.x index on 2026-05-04.
NODE_VERSION="${NODE_VERSION:-v20.20.2}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/node-v20}"
TMP_DIR="${TMP_DIR:-$HOME/.cache/ivucx-node}"

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW"
    exit 1
    ;;
esac

mkdir -p "$TMP_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

ARCHIVE_NAME="node-${NODE_VERSION}-linux-${ARCH}.tar.xz"
ARCHIVE_PATH="$TMP_DIR/$ARCHIVE_NAME"
ARCHIVE_URL="https://nodejs.org/download/release/${NODE_VERSION}/${ARCHIVE_NAME}"

echo "Downloading $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xJf "$ARCHIVE_PATH" -C "$INSTALL_DIR" --strip-components=1

echo "Installed Node.js to $INSTALL_DIR"
"$INSTALL_DIR/bin/node" -v
"$INSTALL_DIR/bin/npm" -v

echo
echo "To use it in the current shell:"
echo "export PATH=\"$INSTALL_DIR/bin:\$PATH\""
