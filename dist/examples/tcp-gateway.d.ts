/**
 * TCP Modbus gateway example.
 *
 * Starts a Modbus TCP gateway that forwards incoming requests to
 * downstream Modbus servers based on unit ID routing. Each unit ID
 * range is mapped to a downstream server via the gateway config.
 *
 * This example configures two downstream servers:
 * - Unit 1 → 192.168.1.10:502
 * - Unit 2 → 192.168.1.20:502
 *
 * @example bun run examples/tcp-gateway.ts
 */
export {};
