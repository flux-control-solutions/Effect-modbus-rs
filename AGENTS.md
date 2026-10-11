# @flux-control/effect-modbus-rs

Effect 4 services for native and browser Modbus transports, using the `modbus-rs` bindings.

## Development

Use Bun for package development.
Run commands from this repository's root. If a parent workspace manages dependencies, install from that workspace's root.

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run format` checks formatting. Use `bun run format:fix` to write formatting changes.
Use `bun run lint:fix` to apply lint fixes.
After dependency changes, run `bun run lock` to regenerate and validate the lockfile.

Package exports use `dist/`. Build before testing package imports, running the browser example, or preparing a release.
Run checks relevant to the change. For documentation-only changes, check formatting, paths, commands, and technical accuracy.

The separate `examples/wasm/` application uses npm and Vite, as documented in its `README.md`.
Package tests and type checks do not check that application. Verify browser changes with its build and the affected browser interaction.

### Commit hook

- `bun install` installs the Husky hook through `prepare`. Run `bun run prepare` to reinstall it.
- The hook checks lockfile staging, fixes staged files with `lint-staged`, then runs package lint and tests.
- Oxlint fixes run before oxfmt. Remaining lint errors or test failures block the commit.
- Keep lint-staged's default backup and partial-staging protection enabled. Do not add a separate `git add` step.
- Package lint and tests run against the working tree after staged fixes.
- Run required type checks, builds, and Fallow audits separately before PR handoff.

### Fallow audit

- For code, dependency, or tooling configuration changes, run a Fallow audit alongside relevant type checks, lint, formatting, and tests.
- Run the audit from this repository's root after the final edits, before committing or opening or updating a pull request.

```bash
bunx fallow audit --base <base-ref>
```

- Replace `<base-ref>` with the merge-base commit between `HEAD` and the intended PR target branch.
- For uncommitted work only, use `HEAD`. Do not use `HEAD` to verify commits already included in a PR.
- The Fallow MCP `audit` tool is equivalent. Set `root` to this repository and `base` to the same comparison ref.
- Inspect the verdict and findings. Fix verified findings introduced by the change, then rerun the audit.
- Verify usage before deleting reported code or dependencies. Public exports can have consumers outside this repository.
- Explain remaining findings or false positives. Do not weaken rules or add baselines only to obtain a passing result.
- If Fallow cannot run, report the blocker. Do not count a skipped audit as a pass.
- Documentation-only changes do not require a Fallow audit.

## Transport lifecycle and retries

- Define transport services with `Context.Service`, scoped constructor effects, and explicit `make(options)` layer factories.
- Keep connection acquisition and cleanup within the consuming scope.
- Load native and browser bindings dynamically to avoid loading native modules during browser initialization.
- Cache clients per unit ID.
- Convert binding errors to the typed `ModbusError` union through `src/errors.ts`.
- Keep retries, reconnection, and circuit-breaker behavior in the transport layer.
- Preserve opt-in retry and reconnection defaults. Keep jitter enabled within retry policies by default.
- Client retry overrides replace the transport policy. Do not compose them into nested retries.
- Use `retryModbus(policy)` only around clients with `RetryPolicies.none()` when retrying a compound operation.
- Keep one reconnection supervisor per transport, rather than one per failing caller.
- Keep upstream retry options excluded by `WithoutUpstreamRetry`. Preserve the compile-time assertions in `test/upstream-options.test.ts`.

## Batching and cache rules

- Keep transaction planning pure in `src/register-plan.ts`.
- Keep caches and debouncers independently usable. Compose them in `src/batching-client.ts`.
- Do not make `BatchingModbusClient` extend `ModbusOperations`. Raw writes can bypass the cache and reorder pending writes.
- After declaring a batching client, preserve the guards on raw FC06, FC16, and FC23 operations for that unit.
- Preserve raw reads, coils, and other operations outside register-write batching.
- Keep debounce windows opt-in. A zero window must bypass the timer.
- Keep grouped operations on the debouncer path. With a positive window, `writeAll` and `readAll` collect before issuing.
- Use `writeAllNow` and `readAllNow` to flush grouped operations immediately.
- Keep one write cache per transport. Create the cache and its connection watcher only when batching is first requested.
- Invalidate a unit's cache after a failed write. Invalidate all cached writes when the connection leaves `Connected`.
- Compare cached values using their wire encoding.
- Cache one batching client per unit ID. Reject every later declaration of the unit with `ModbusUnitAlreadyDeclaredError`.
- Keep `ModbusUnitAlreadyDeclaredError` out of the `ModbusError` union. It is a declaration error, not a bus error, so retry policies do not apply to it.
- Open `modbus.write` spans after cache filtering and only for writes that reach the bus.
- Apply caller span attributes first and reserved `modbus.*` attributes last. Join repeated batch attribute values with commas.

See `README.md` for lifecycle diagrams, configuration details, and examples.

## Browser support and verification

- Use `modbus-rs/web` for browser bindings and their type imports.
- Call `requestSerialPort()` from a user-gesture handler to preserve the browser permission requirement.
- When upgrading bindings, check the published declarations and browser exports. The example's `/export-check.html` inspects runtime exports.
- Verify response normalization in `src/modbus-client.ts` against the installed bindings.
- Do not retain historical upstream failures as current limitations without reproducing them against the installed version.
- Use service mock layers for deterministic transport behavior tests. Import test helpers from `bun:test`.
- Test changed retry counts, cache invalidation, batching order, failures, and cleanup.
- Use `import type` for type-only imports. Let oxfmt control formatting and import order.

## Tooling

- Keep generated `CHANGELOG.md` excluded from oxfmt. Changesets controls its formatting.
- Keep dependency versions and compiler settings in `package.json` and the TypeScript configuration.

## Written communication

Use Simplified Technical English principles for all text you create or revise.
This includes documentation, code comments, JSDoc, TODOs, test descriptions, error messages, and agent instructions.
It also includes commit messages, pull requests, review comments, release notes, and Linear titles, descriptions, comments, and updates.
Apply the same rules to prose inside examples, code blocks, and Markdown or HTML comments.

- Use short sentences, active voice, and concrete words.
- Give one instruction per sentence. Put each condition before the action that depends on it.
- Use the same term for the same concept.
- Aim for 20 words per instruction sentence and 25 words per descriptive sentence.
- Avoid idioms, metaphors, contractions, and unnecessary background.
- Explain the reason or constraint in code comments. Do not repeat the code.
- Preserve technical meaning, identifiers, commands, units, and required legal wording.
- Keep necessary quotations exact and identify them as quotations. Apply the public-repository rules to quotations too.
- Do not claim formal ASD-STE100 compliance without a complete review.

## Public repository

Treat this repository and its associated development records as public, regardless of its current visibility.

- Keep private information from consumers, customers, deployments, and other repositories out of public work.
- Apply this rule to every repository file, including agent instructions, code, comments, tests, fixtures, and examples.
- Apply it to documentation, commit messages, branch names, pull requests, review comments, issues, changesets, and release notes.
- Apply it to logs, screenshots, and other attachments intended for publication.
- Do not include private issue identifiers, URLs, customer names, deployment details, internal paths, or consumer-specific configuration.
- Use public dependency names and public repository references when needed.
- Use synthetic examples. Describe library requirements without naming private consumers.
- Accept consumer-specific context through parameters instead of embedding private values.
- Keep private tracking references in private records. Public records must remain understandable without private context.
- Check the destination repository and all proposed public text before committing, pushing, or opening a pull request.

## Commits and pull requests

- Commit, push, or open pull requests only when requested.
- Follow the repository's commit conventions. Use an imperative summary and explain important reasons in the body.
- Describe the change, verification results, and remaining limitations in pull requests.
- Include the Fallow audit scope, base ref, verdict, and unresolved findings with lint, formatting, type-check, and test results.
- Report failed checks and checks that you could not run.
- Do not rewrite published history unless explicitly requested.
- Keep `CLAUDE.md` as an `@AGENTS.md` import. Keep these instructions complete for a standalone clone.
