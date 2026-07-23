import type { ServerHandlers } from "modbus-rs";
import type { WasmTcpServerOptions } from "modbus-rs/web";
import { Effect, Layer } from "effect";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * A scoped {@link Layer} that starts a browser Modbus server proxied over a
 * WebSocket gateway (experimental upstream surface — browsers can't accept raw
 * TCP connections, so this binds via `modbus-gateway` or an equivalent WS-to-TCP
 * proxy).
 *
 * Unlike the native {@link tcpServerLayer}, the WASM server does not start
 * serving on `bind()` — it requires an explicit, continuously-awaited `serve()`
 * call to drive its request loop. This layer forks that call into the scope in
 * the background so the returned `Layer` behaves the same as the native one
 * from the consumer's perspective (no extra step needed).
 *
 * @param options - WebSocket gateway URL and unit ID.
 * @param handlers - Callback functions that handle incoming Modbus requests
 *   (same {@link ServerHandlers} shape as the native TCP/serial servers).
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { wasmWsServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = wasmWsServerLayer(
 *   { wsUrl: "ws://localhost:8080", unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see WasmTcpServerOptions — Options accepted by the upstream WASM WS server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export const wasmWsServerLayer = (
  options: WasmTcpServerOptions,
  handlers: ServerHandlers,
): Layer.Layer<never, ModbusError> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const { WasmWsModbusServer } = yield* Effect.promise(() => import("modbus-rs/web"));
      const server = yield* Effect.tryPromise({
        try: () => WasmWsModbusServer.bind(options, handlers),
        catch: (error) => toModbusError(error as Error),
      });

      yield* Effect.logDebug(`WASM WS server bound to ${options.wsUrl}`);

      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: () => server.serve(),
          catch: (error) => toModbusError(error as Error),
        }).pipe(
          Effect.catchAll((error) => Effect.logError("WASM WS server loop ended", error)),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.logDebug("WASM WS server shutting down").pipe(
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
