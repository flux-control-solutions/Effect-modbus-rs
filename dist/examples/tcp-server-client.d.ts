/**
 * TCP server + client integration example.
 *
 * Forks a TCP Modbus server into a background fiber, then creates a
 * `TcpTransportService` client that connects to the same port and
 * performs read/write operations against the server's in-memory state.
 *
 * Demonstrates:
 * - `Effect.fork` + `Layer.launch` to run a server in the background
 * - Client operations (read/write coils and holding registers)
 * - Graceful server shutdown via `Fiber.interrupt`
 *
 * @example bun run examples/tcp-server-client.ts
 */
export {};
