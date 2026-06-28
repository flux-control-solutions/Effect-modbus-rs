import { Effect, Exit, Scope } from "effect";
import {
  type ModbusError,
  ModbusNotConnectedError,
  toModbusError,
} from "./errors";
import { makeEffectModbusClient, type AnyModbusClient, type EffectModbusClient } from "./modbus-client";

export interface TransportServiceApi {
  withClient(unitId: number): Effect.Effect<EffectModbusClient, ModbusError>;
  setRequestTimeout(timeoutMs: number): Effect.Effect<void, ModbusError>;
  clearRequestTimeout(): Effect.Effect<void, ModbusError>;
  reconnect(): Effect.Effect<void, ModbusError>;
  close(): Effect.Effect<void, never>;
  hasPendingRequests(): boolean;
}

interface TransportHandle<TClient> {
  close(): Promise<void>;
  createClient(opts: { unitId: number }): TClient;
  setRequestTimeout(ms: number): void;
  clearRequestTimeout(): void;
  reconnect(): Promise<void>;
  pendingRequests: boolean;
}

export function makeTransportScoped<
  TOptions,
  TClient extends AnyModbusClient,
  TTransport extends TransportHandle<TClient>,
>(
  transportKey: string,
  openMethod: (TC: unknown, options: TOptions) => Promise<TTransport>,
  serviceName: string,
) {
  return Effect.fnUntraced(function* (options: TOptions) {
    const mod: Record<string, unknown> = yield* Effect.promise(() =>
      import("modbus-rs"),
    );
    const TC = mod[transportKey];

    let transport: TTransport | null = null;
    let connectPromise: Promise<TTransport> | null = null;
    let reconnectPromise: Promise<void> | null = null;

    const clientSet = new Map<number, TClient>();

    let closed = false;

    const ensureOpen = Effect.fnUntraced(function* () {
      if (transport) {
        if (closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error("Transport has been closed"),
            message: "Transport has been closed",
          });
        }
        return transport;
      }
      if (closed) {
        return yield* new ModbusNotConnectedError({
          cause: new Error("Transport has been closed"),
          message: "Transport has been closed",
        });
      }
      if (!connectPromise) {
        connectPromise = openMethod(TC, options);
      }
      const t = yield* Effect.tryPromise({
        try: () => connectPromise!,
        catch: (error) => toModbusError(error as Error),
      }).pipe(
        Effect.catchAll((err) => {
          connectPromise = null;
          return Effect.fail(err);
        }),
      );
      if (closed) {
        connectPromise = null;
        yield* Effect.fork(Effect.promise(() => t.close()).pipe(Effect.catchAll(() => Effect.void)));
        return yield* new ModbusNotConnectedError({
          cause: new Error("Transport has been closed"),
          message: "Transport has been closed",
        });
      }
      transport = t;
      return t;
    });

    yield* Effect.addFinalizer(() => {
      if (closed) return Effect.void;
      closed = true;
      const t = transport;
      if (!t) return Effect.void;
      return Effect.andThen(
        Effect.logDebug(`Closing ${serviceName}`),
        Effect.promise(() => t.close()),
      );
    });

    const notConnectedMsg = "Transport is not connected. Call withClient() first.";

    return {
      withClient: Effect.fnUntraced(function* (unitId: number) {
        const t = yield* ensureOpen();
        let client = clientSet.get(unitId);
        if (!client) {
          client = yield* Effect.try({
            try: () => t.createClient({ unitId }),
            catch: (error) => toModbusError(error as Error),
          });
          clientSet.set(unitId, client);
        }
        return makeEffectModbusClient(client);
      }),

      setRequestTimeout: Effect.fnUntraced(function* (timeoutMs: number) {
        const t = transport;
        if (!t || closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error(notConnectedMsg),
            message: notConnectedMsg,
          });
        }
        t.setRequestTimeout(timeoutMs);
      }),

      clearRequestTimeout: Effect.fnUntraced(function* () {
        const t = transport;
        if (!t || closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error(notConnectedMsg),
            message: notConnectedMsg,
          });
        }
        t.clearRequestTimeout();
      }),

      reconnect: Effect.fnUntraced(function* () {
        if (closed) {
          return yield* new ModbusNotConnectedError({
            cause: new Error("Transport has been closed"),
            message: "Transport has been closed",
          });
        }
        if (transport) {
          if (!reconnectPromise) {
            reconnectPromise = transport
              .reconnect()
              .then(() => {
                reconnectPromise = null;
              })
              .catch((err) => {
                reconnectPromise = null;
                throw err;
              });
          }
          yield* Effect.tryPromise({
            try: () => reconnectPromise!,
            catch: (error) => toModbusError(error as Error),
          });
        } else {
          yield* ensureOpen();
        }
      }),

      close: Effect.fnUntraced(function* () {
        if (closed) return;
        closed = true;
        const t = transport;
        if (t) {
          yield* Effect.tryPromise({
            try: () => t.close(),
            catch: (error) => toModbusError(error as Error),
          });
        }
        const scope = yield* Effect.scope;
        yield* Scope.close(scope as Scope.CloseableScope, Exit.void);
      }),

      hasPendingRequests: () => {
        if (closed) return false;
        const t = transport;
        if (!t) return false;
        return t.pendingRequests;
      },
    };
  });
}
