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

import { Console, Effect, Layer, LogLevel, Logger } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import type { GatewayConfig } from "modbus-rs";
import { tcpGatewayLayer } from "../src/TcpGatewayService";

const gatewayConfig: GatewayConfig = {
  downstreams: [
    { host: "192.168.1.10", port: 502 },
    { host: "192.168.1.20", port: 502 },
  ],
  routes: [
    { unitId: 1, channel: 0 },
    { unitId: 2, channel: 1 },
  ],
};

const GatewayLive = tcpGatewayLayer(
  { host: "0.0.0.0", port: 8502 },
  gatewayConfig,
);

BunRuntime.runMain(
  Layer.launch(GatewayLive).pipe(
    Effect.catchAll((err) => Console.log(`Gateway error: ${err.message}`)),
    Effect.provide(Logger.pretty),
    Logger.withMinimumLogLevel(LogLevel.Debug),
  ),
);
