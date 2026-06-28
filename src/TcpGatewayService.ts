import type { AsyncTcpGateway, GatewayBindOptions, GatewayConfig } from "modbus-rs";
import { Effect, Layer } from "effect";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * A scoped {@link Layer} that starts a Modbus TCP gateway.
 *
 * The gateway binds to the specified host and port, forwarding incoming
 * Modbus requests to downstream servers based on unit ID routing defined
 * in the {@link GatewayConfig}. The gateway is automatically shut down
 * when the consuming scope finalizes.
 *
 * @param options - Gateway bind options (host, port).
 * @param gatewayConfig - Routing configuration with downstream server
 *   definitions and a unit-ID-to-channel route table.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { tcpGatewayLayer } from "effect-modbus-rs";
 *
 * const GatewayLive = tcpGatewayLayer(
 *   { host: "0.0.0.0", port: 8502 },
 *   {
 *     downstreams: [
 *       { host: "192.168.1.10", port: 502 },
 *       { host: "192.168.1.20", port: 502 },
 *     ],
 *     routes: [
 *       { unitId: 1, channel: 0 },
 *       { unitId: 2, channel: 1 },
 *     ],
 *   },
 * );
 *
 * Layer.launch(GatewayLive).pipe(Effect.runPromise);
 * ```
 *
 * @see GatewayBindOptions — Options for the gateway bind address.
 * @see GatewayConfig — Configuration for downstream servers and routing.
 */
export const tcpGatewayLayer = (
  options: GatewayBindOptions,
  gatewayConfig: GatewayConfig,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { AsyncTcpGateway } = yield* Effect.promise(() => import("modbus-rs"));
      const gateway = yield* Effect.tryPromise({
        try: () => AsyncTcpGateway.bind(options, gatewayConfig),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug(`TCP gateway bound to ${options.host}:${options.port}`);

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("TCP gateway shutting down").pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => gateway.shutdown(),
              catch: (error) => toModbusError(error as Error),
            }),
          ),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }),
  );
