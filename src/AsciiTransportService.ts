import {
  type AsyncAsciiTransport,
  type AsyncSerialModbusClient,
  type AsciiTransportOptions,
} from "modbus-rs";
import { Effect, Layer } from "effect";
import { toModbusError } from "./errors.js";
import { makeEffectModbusClient } from "./modbus-client.js";
import { makeMockTransport, SlaveDeviceDefinitions } from "./mocks.js";

/**
 * Effect-TS scoped service wrapping a `modbus-rs` ASCII serial transport.
 *
 * Opens a serial port in ASCII mode via {@link AsyncAsciiTransport.open}
 * and manages a scoped lifecycle — the transport is automatically closed
 * when the consuming `Scope` finalizes.
 *
 * Device clients are cached per {@link CreateClientOptions.unitId | unitId}
 * so that repeated calls to `withClient` for the same unit share the
 * underlying `AsyncSerialModbusClient`. Each returned client is a
 * lightweight {@link EffectModbusClient} that converts Promise-based
 * upstream calls into `Effect.Effect` with typed error handling.
 *
 * ### Usage
 *
 * ```ts
 * import { AsciiTransportService } from "./AsciiTransportService.js";
 * import { Layer } from "effect";
 *
 * const layer = AsciiTransportService.default({ portPath: "/dev/ttyUSB0", baudRate: 19200 });
 * ```
 *
 * @see AsyncAsciiTransport — Upstream `modbus-rs` ASCII transport class.
 * @see AsciiTransportOptions — Connection options for the serial ASCII port.
 * @see AsyncSerialModbusClient — Client type created by the ASCII transport.
 */
export class AsciiTransportService extends Effect.Service<AsciiTransportService>()(
  "AsciiTransportService",
  {
    scoped: Effect.fnUntraced(function* (options: AsciiTransportOptions) {
      const { AsyncAsciiTransport } = yield* Effect.promise(
        () => import("modbus-rs"),
      );

      /**
       * The underlying ASCII transport instance, connected to the serial port.
       */
      const transport: AsyncAsciiTransport = yield* Effect.tryPromise({
        try: () => AsyncAsciiTransport.open(options),
        catch: (error) => toModbusError(error as Error),
      });

      /**
       * Cache of device clients keyed by unit ID, so the same unit's
       * client is reused across the scope's lifetime.
       */
      const clientSet = new Map<number, AsyncSerialModbusClient>();

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
         * Each client shares the parent serial transport. Caching avoids
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
         * Sets the per-request timeout on the underlying ASCII transport.
         *
         * Delegates to {@link AsyncAsciiTransport.setRequestTimeout}.
         *
         * @param timeoutMs - Timeout duration in milliseconds.
         */
        setRequestTimeout: transport.setRequestTimeout.bind(transport),

        /**
         * Clears any previously set per-request timeout.
         *
         * Delegates to {@link AsyncAsciiTransport.clearRequestTimeout}.
         */
        clearRequestTimeout: transport.clearRequestTimeout.bind(transport),

        /**
         * Reconnects the transport after a disconnect.
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
         * Closes the transport connection immediately.
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
         * Delegates to {@link AsyncAsciiTransport.pendingRequests}.
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
    return (options: AsciiTransportOptions) =>
      Layer.scoped(
        AsciiTransportService,
        factory(options) as unknown as Effect.Effect<AsciiTransportService>,
      );
  };
}
