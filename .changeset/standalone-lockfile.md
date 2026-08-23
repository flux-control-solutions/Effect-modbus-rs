---
'@flux-control/effect-modbus-rs': patch
---

Regenerate `bun.lock` as a standalone package, and add `bun run lock` to keep
it that way. The lockfile is resolved in an isolated directory, so it records
registry versions even when this repo is checked out inside a bun workspace,
where an ordinary install writes only the workspace root's lockfile. A
pre-commit check now refuses a dependency change that leaves the lockfile
behind.

No published code changes: the lockfile is not part of the package.
