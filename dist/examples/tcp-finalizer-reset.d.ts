/**
 * Demonstrates using scope finalizers to reset Modbus device state.
 *
 * Writes values to a mock device, registers a finalizer that resets
 * them to 0, then verifies the reset after the scope exits.
 *
 * The finalizer via `Effect.addFinalizer` runs automatically when the
 * enclosing `Effect.scoped` block completes (success, failure, or
 * interruption), ensuring cleanup even on error paths.
 *
 * @example bun run examples/tcp-finalizer-reset.ts
 */
export {};
