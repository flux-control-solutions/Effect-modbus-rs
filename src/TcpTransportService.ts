import {
  type AsyncTcpTransport,
  type AsyncTcpModbusClient,
  type TcpTransportOptions,
} from "modbus-rs";
import { Effect, Layer } from "effect";
import { toModbusError } from "./errors.js";
import { makeEffectModbusClient } from "./modbus-client.js";
import { SlaveDeviceDefinitions, makeMockTransport } from "./mocks.js";

/**
 * Effect-TS scoped service wrapping a `modbus-rs` TCP transport.
 *
 * Connects to a remote Modbus device or gateway via TCP socket using
 * {@link AsyncTcpTransport.connect} and manages a scoped lifecycle —
 * the transport is automatically closed when the consuming `Scope`
 * finalizes.
 *
 * Device clients are cached per {@link CreateClientOptions.unitId | unitId}
 * so that repeated calls to `withClient` for the same unit share the
 * underlying `AsyncTcpModbusClient`. Each returned client is a
 * lightweight {@link EffectModbusClient} that converts Promise-based
 * upstream calls into `Effect.Effect` with typed error handling.
 *
 * ### Usage
 *
 * ```ts
 * import { TcpTransportService } from "./TcpTransportService.js";
 * import { Layer } from "effect";
 *
 * const layer = TcpTransportService.default({ host: "192.168.1.10", port: 502 });
 * ```
 *
 * @see AsyncTcpTransport — Upstream `modbus-rs` TCP transport class.
 * @see TcpTransportOptions — Connection options for the TCP socket.
 * @see AsyncTcpModbusClient — Client type created by the TCP transport.
 */
export class TcpTransportService extends Effect.Service<TcpTransportService>()(
  "TcpTransportService",
  {
    scoped: Effect.fnUntraced(function* (options: TcpTransportOptions) {
      const { AsyncTcpTransport } = yield* Effect.promise(
        () => import("modbus-rs"),
      );

      /**
       * The underlying TCP transport instance, connected to the remote host.
       */
      const transport: AsyncTcpTransport = yield* Effect.tryPromise({
        try: () => AsyncTcpTransport.connect(options),
        catch: (error) => toModbusError(error as Error),
      });

      /**
       * Cache of device clients keyed by unit ID, so the same unit's
       * client is reused across the scope's lifetime.
       */
      const clientSet = new Map<number, AsyncTcpModbusClient>();

      /**
       * Registers a finalizer that closes the transport when the
       * consuming Effect scope completes or is interrupted.
       */
      yield* Effect.addFinalizer(() => Effect.promise(() => transport.close()));

      return {
        /**
         * Retrieves (or creates and caches) a Modbus client for the
         * given unit ID, wrapping it as an {@link EffectModbusClient}.
         *
         * Each client shares the parent TCP transport. Caching avoids
         * redundant `transport.createClient` calls and ensures any
         * `setRequestTimeout`/`clearRequestTimeout` configuration applies
         * consistently.
         *
         * @param unitId - The Modbus unit ID (1-247) of the target device.
         * @returns An `EffectModbusClient` scoped to the transport's
         *          lifetime.
         */
        withClient: Effect.fnUntraced(function* (unitId: number) {
          let client = clientSet.get(unitId);
          if (!client) {
            client = yield* Effect.try({
              try: () => transport.createClient({ unitId }),
              catch: (error) => toModbusError(error as Error),
            });
            clientSet.set(unitId, client);
          }
          return makeEffectModbusClient(client);
        }),

        /**
         * Sets the per-request timeout on the underlying TCP transport.
         *
         * Delegates to {@link AsyncTcpTransport.setRequestTimeout}.
         *
         * @param timeoutMs - Timeout duration in milliseconds.
         */
        setRequestTimeout: transport.setRequestTimeout.bind(transport),

        /**
         * Clears any previously set per-request timeout.
         *
         * Delegates to {@link AsyncTcpTransport.clearRequestTimeout}.
         */
        clearRequestTimeout: transport.clearRequestTimeout.bind(transport),

        /**
         * Reconnects the TCP transport after a disconnect.
         *
         * Useful for recovering from {@link ModbusConnectionClosedError}
         * or {@link ModbusTransportError} conditions.
         *
         * @returns An Effect that resolves when reconnection completes.
         */
        reconnect: Effect.tryPromise({
          try: () => transport.reconnect(),
          catch: (error) => toModbusError(error as Error),
        }),

        /**
         * Closes the TCP connection immediately.
         *
         * Normally the transport is closed via the scope finalizer, but
         * this method allows explicit early termination.
         *
         * @returns An Effect that resolves when the transport is closed.
         */
        close: Effect.tryPromise({
          try: () => transport.close(),
          catch: (error) => toModbusError(error as Error),
        }),

        /**
         * Returns whether the transport has any pending (in-flight)
         * Modbus requests.
         *
         * Delegates to {@link AsyncTcpTransport.pendingRequests}.
         *
         * @returns `true` if there are pending requests, `false` otherwise.
         */
        hasPendingRequests: () => transport.pendingRequests,
      };
    }),
  },
) {
  static makeMockRtuTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: TcpTransportOptions) =>
      Layer.scoped(
        TcpTransportService,
        factory(options) as unknown as Effect.Effect<TcpTransportService>,
      );
  };
}
