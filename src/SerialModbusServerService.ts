import type { SerialServerOptions, ServerHandlers } from "modbus-rs";
import { Effect, Layer } from "effect";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * A scoped {@link Layer} that starts a Modbus serial RTU server.
 *
 * @param options - Serial port options (path, baud rate, unit ID, etc.).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { serialRtuServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = serialRtuServerLayer(
 *   { portPath: "/dev/ttyUSB0", baudRate: 9600, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see SerialServerOptions — Options accepted by the upstream serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const serialRtuServerLayer = (
  options: SerialServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { AsyncSerialModbusServer } = yield* Effect.promise(() => import("modbus-rs"));
      const server = yield* Effect.tryPromise({
        try: () => AsyncSerialModbusServer.bindRtu(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug(`Serial RTU server bound to ${options.portPath}`);

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("Serial RTU server shutting down").pipe(
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

/**
 * A scoped {@link Layer} that starts a Modbus serial ASCII server.
 *
 * @param options - Serial port options (path, baud rate, unit ID, etc.).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { serialAsciiServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = serialAsciiServerLayer(
 *   { portPath: "/dev/ttyUSB0", baudRate: 9600, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see SerialServerOptions — Options accepted by the upstream serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const serialAsciiServerLayer = (
  options: SerialServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { AsyncSerialModbusServer } = yield* Effect.promise(() => import("modbus-rs"));
      const server = yield* Effect.tryPromise({
        try: () => AsyncSerialModbusServer.bindAscii(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug(`Serial ASCII server bound to ${options.portPath}`);

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("Serial ASCII server shutting down").pipe(
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
