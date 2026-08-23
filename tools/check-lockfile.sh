#!/usr/bin/env bash
#
# Refuse a commit that changes dependencies without the matching bun.lock.
#
# bun.lock cannot be refreshed by an ordinary install when this package sits
# inside a bun workspace (see tools/refresh-lockfile.sh), so it is easy to
# change package.json and leave the lockfile behind. CI installs with
# --frozen-lockfile and fails on the drift; this catches it a step earlier.

set -euo pipefail

staged="$(git diff --cached --name-only --diff-filter=ACM)"

case "$staged" in
  *package.json*) ;;
  *) exit 0 ;;
esac

if echo "$staged" | grep -qx 'bun.lock'; then
  exit 0
fi

# Only the fields that feed resolution matter; a version or script edit does
# not need a new lockfile.
extract='const p = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify([p.dependencies, p.devDependencies, p.peerDependencies, p.optionalDependencies, p.overrides, p.resolutions]));'

if git rev-parse --verify --quiet HEAD:package.json > /dev/null; then
  before="$(git show HEAD:package.json | bun -e "$extract")"
else
  before=''
fi
after="$(git show :package.json | bun -e "$extract")"

if [ "$before" = "$after" ]; then
  exit 0
fi

echo 'package.json dependencies changed but bun.lock is not staged.' >&2
echo 'Run `bun run lock`, then stage bun.lock with this commit.' >&2
exit 1
