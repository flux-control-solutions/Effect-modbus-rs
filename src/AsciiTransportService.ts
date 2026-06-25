import { type AsyncAsciiTransport, type AsciiTransportOptions } from "modbus-rs";
import { Effect } from "effect";
import { toModbusError } from "./errors.js";
import { type AsyncSerialModbusClient, makeEffectSerialClient } from "./serial-client.js";

export class AsciiTransportService extends Effect.Service<AsciiTransportService>()(
  "AsciiTransportService",
  {
    scoped: Effect.fnUntraced(function* (options: AsciiTransportOptions) {
      const { AsyncAsciiTransport } = yield* Effect.promise(
        () => import("modbus-rs"),
      );

      const transport: AsyncAsciiTransport = yield* Effect.tryPromise({
        try: () => AsyncAsciiTransport.open(options),
        catch: (error) => toModbusError(error as Error),
      });
      const clientSet = new Map<number, AsyncSerialModbusClient>();

      yield* Effect.addFinalizer(() => Effect.promise(() => transport.close()));

      return {
        withClient: Effect.fnUntraced(function* (unitId: number) {
          let client = clientSet.get(unitId);
          if (!client) {
            client = yield* Effect.try({
              try: () => transport.createClient({ unitId }),
              catch: (error) => toModbusError(error as Error),
            });
            clientSet.set(unitId, client);
          }
          return makeEffectSerialClient(client);
        }),
        setRequestTimeout: transport.setRequestTimeout.bind(transport),
        clearRequestTimeout: transport.clearRequestTimeout.bind(transport),
        reconnect: Effect.tryPromise({
          try: () => transport.reconnect(),
          catch: (error) => toModbusError(error as Error),
        }),
        hasPendingRequests: () => transport.pendingRequests,
      };
    }),
  },
) {}
