#!/usr/bin/env bash
#
# Regenerate bun.lock as a standalone package.
#
# This package may be checked out inside a bun workspace. Bun then maintains
# only the workspace root's lockfile: an install run from this directory
# leaves bun.lock untouched, and the lockfile the root does write resolves any
# dependency that is also a workspace member to a workspace link, which does
# not exist in a standalone checkout. Resolving in an isolated directory keeps
# bun.lock on registry versions, which is what `bun install --frozen-lockfile`
# needs in CI and what anyone cloning this repo on its own needs.
#
# The existing lockfile is carried into the isolated directory so already
# resolved versions are preserved and only what package.json changed moves.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$root/package.json" "$tmp/"
if [ -f "$root/bun.lock" ]; then
  cp "$root/bun.lock" "$tmp/"
fi
if [ -f "$root/bunfig.toml" ]; then
  cp "$root/bunfig.toml" "$tmp/"
fi

(cd "$tmp" && bun install --lockfile-only)

cp "$tmp/bun.lock" "$root/bun.lock"
echo "bun.lock regenerated from package.json"
