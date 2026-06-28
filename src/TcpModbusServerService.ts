import type { AsyncTcpModbusServer, ServerHandlers, TcpServerOptions } from "modbus-rs";
import { Effect, Layer } from "effect";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * A scoped {@link Layer} that starts a Modbus TCP server.
 *
 * The server binds to the specified host and port, handling incoming
 * Modbus requests via the provided {@link ServerHandlers}. The connection
 * is automatically shut down when the consuming scope finalizes.
 *
 * @param options - Server bind options (host, port, unit ID).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { tcpServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = tcpServerLayer(
 *   { host: "0.0.0.0", port: 502, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see TcpServerOptions — Options accepted by the upstream TCP server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const tcpServerLayer = (
  options: TcpServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { AsyncTcpModbusServer } = yield* Effect.promise(() => import("modbus-rs"));
      const server = yield* Effect.tryPromise({
        try: () => AsyncTcpModbusServer.bind(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug(`TCP server bound to ${options.host}:${options.port}`);

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("TCP server shutting down").pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => server.shutdown(),
              catch: (error) => toModbusError(error as Error),
            }),
          ),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }),
  );
