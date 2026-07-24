# reference-dependencies

Load this skill when you need to look up how a type, function, or module works in `effect`, `@effect/*`, or `modbus-rs`.

## Sources

Shallow clones of upstream libraries exist under `references/`:

| Library              | Local path                    | Useful subdirectory                                                                      |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `effect`             | `references/effect`           | `packages/effect/src/` for core types                                                    |
| `@effect/*` packages | `references/effect/packages/` | Each sub-package mirrors the npm name                                                    |
| `modbus-rs`          | `references/modbus-rs`        | `mbus-ffi/nodejs/` for the Node.js binding (`index.d.ts` for types, `index.js` for impl) |

## Rules

1. **Never guess API signatures.** If you need to use a type or function from effect, `@effect/*`, or `modbus-rs`, first read the source or type definitions from the corresponding reference clone.
2. If a clone is missing, create it with `git clone --depth 1 <url> references/<name>` using the URLs from `AGENTS.md`.
3. If a clone is stale, delete and re-clone it.
