/**
 * Example demonstrating the mock TCP transport layer with multiple devices.
 *
 * Creates an in-memory TCP transport with
 * {@link TcpTransportService.makeMockTransport},
 * simulates two Modbus slave devices (unit IDs 1 and 2) with different register maps,
 * and exercises read/write operations on both devices.
 *
 * @example bun run examples/tcp-mock.ts
 */
export {};
