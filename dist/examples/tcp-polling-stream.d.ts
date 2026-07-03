/**
 * TCP polling stream example.
 *
 * Polls a localhost Modbus/TCP device every 5 seconds, yielding
 * holding-register values as a `Stream`. The stream is consumed
 * eagerly (despite errors) and each poll result is logged.
 *
 * @example bun run examples/tcp-polling-stream.ts
 */
export {};
