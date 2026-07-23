import type { ServerHandlers } from "modbus-rs";
import type { WasmSerialServerOptions } from "modbus-rs/web";
import { Effect, Layer } from "effect";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * A scoped {@link Layer} that starts a browser Modbus RTU server over the Web
 * Serial API (experimental upstream surface).
 *
 * `options.serialPort` is the raw `SerialPort` object obtained from the
 * consumer's own app code via `navigator.serial.requestPort()` (which has the
 * `dom` lib types available) — **not** this package's {@link requestSerialPort}
 * helper, which returns the `WasmSerialPortHandle` wrapper used only by the
 * client-side transports (`WasmRtuTransportService`/`WasmAsciiTransportService`).
 *
 * Like {@link wasmWsServerLayer}, the WASM server requires a continuously-awaited
 * `serve()` call to drive its request loop; this layer forks that call into the
 * scope automatically so the returned `Layer` "just works".
 *
 * @param options - Serial port, baud rate, unit ID, etc.
 * @param handlers - Callback functions that handle incoming Modbus requests
 *   (same {@link ServerHandlers} shape as the native TCP/serial servers).
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { wasmSerialRtuServerLayer } from "effect-modbus-rs";
 *
 * const port = await navigator.serial.requestPort(); // user-gesture gated
 * const ServerLive = wasmSerialRtuServerLayer(
 *   { serialPort: port, unitId: 1, baudRate: 19200 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see WasmSerialServerOptions — Options accepted by the upstream WASM serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const wasmSerialRtuServerLayer = (
  options: WasmSerialServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { WasmSerialModbusServer } = yield* Effect.promise(() => import("modbus-rs/web"));
      const server = yield* Effect.tryPromise({
        try: () => WasmSerialModbusServer.bindRtu(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug("WASM serial RTU server bound");

      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: () => server.serve(),
          catch: (error) => toModbusError(error as Error),
        }).pipe(
          Effect.catchAll((error) => Effect.logError("WASM serial RTU server loop ended", error)),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("WASM serial RTU server shutting down").pipe(
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
 * A scoped {@link Layer} that starts a browser Modbus ASCII server over the Web
 * Serial API. See {@link wasmSerialRtuServerLayer} for shared details (the
 * `serialPort` source, and the `serve()`-forking behavior).
 *
 * @param options - Serial port, baud rate, unit ID, etc.
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @see WasmSerialServerOptions — Options accepted by the upstream WASM serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const wasmSerialAsciiServerLayer = (
  options: WasmSerialServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { WasmSerialModbusServer } = yield* Effect.promise(() => import("modbus-rs/web"));
      const server = yield* Effect.tryPromise({
        try: () => WasmSerialModbusServer.bindAscii(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug("WASM serial ASCII server bound");

      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: () => server.serve(),
          catch: (error) => toModbusError(error as Error),
        }).pipe(
          Effect.catchAll((error) => Effect.logError("WASM serial ASCII server loop ended", error)),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("WASM serial ASCII server shutting down").pipe(
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
