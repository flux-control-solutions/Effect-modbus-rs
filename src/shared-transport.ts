import { Effect, Exit, Scope } from "effect";
import {
  type ModbusError,
  ModbusNotConnectedError,
  toModbusError,
} from "./errors";
import { makeEffectModbusClient, type AnyModbusClient, type EffectModbusClient } from "./modbus-client";

/**
 * Shared API surface that every transport service exposes to consumers.
 *
 * Provides lazy connection, per-unit-ID client caching, timeout management,
 * reconnection, and graceful shutdown — all within the Effect scope.
 *
 * @see makeTransportScoped — Factory that produces this API from a raw transport.
 */
export interface TransportServiceApi {
  /** Obtains (or creates) a cached {@link EffectModbusClient} for the given unit ID. */
  withClient(unitId: number): Effect.Effect<EffectModbusClient, ModbusError>;
  /** Sets a request timeout (ms) on the underlying transport. Fails if not connected. */
  setRequestTimeout(timeoutMs: number): Effect.Effect<void, ModbusError>;
  /** Clears the request timeout. Fails if not connected. */
  clearRequestTimeout(): Effect.Effect<void, ModbusError>;
  /** Reconnects the transport. Opens lazily if no prior connection exists. */
  reconnect(): Effect.Effect<void, ModbusError>;
  /** Closes the transport and its scope immediately. */
  close(): Effect.Effect<void, ModbusError, Scope.Scope>;
  /** Whether the transport currently has in-flight requests. */
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

/**
 * Generic factory for the scoped constructor body of an `Effect.Service`.
 *
 * Dynamically imports `modbus-rs`, opens the transport via `openMethod`,
 * and returns a {@link TransportServiceApi} that manages connection
 * lifecycle, client caching, timeouts, and reconnection.
 *
 * The transport is opened lazily on the first `withClient()` call and
 * automatically closed when the consuming {@link Effect.Scope | Scope}
 * finalizes via `Effect.addFinalizer`.
 *
 * @typeParam TOptions - Transport options (e.g. `RtuTransportOptions`).
 * @typeParam TClient - The client type created by the transport.
 * @typeParam TTransport - The transport handle type.
 * @param transportKey - The named export from `modbus-rs` (e.g. `"AsyncRtuTransport"`).
 * @param openMethod - A function that takes the transport constructor and options,
 *   returning a promise for the opened transport.
 * @param serviceName - Logical name used in log messages and the finalizer guard.
 * @returns An `Effect` that produces a {@link TransportServiceApi}.
 */
export function makeTransportScoped<
  TOptions,
  TClient extends AnyModbusClient,
  TTransport extends TransportHandle<TClient>,
>(
  transportKey: string,
  openMethod: (TC: unknown, options: TOptions) => Promise<TTransport>,
  serviceName: string,
  config?: {
    /** Which `modbus-rs` conditional export to import from. Defaults to `"modbus-rs"` (native). */
    moduleSpecifier?: "modbus-rs" | "modbus-rs/web";
    /** Wraps the raw transport client into an {@link EffectModbusClient}. Defaults to {@link makeEffectModbusClient}. */
    toEffectClient?: (client: TClient) => EffectModbusClient;
  },
) {
  return Effect.fnUntraced(function* (options: TOptions) {
    // Branched as a literal specifier (not a variable) so bundlers reliably apply
    // modbus-rs's conditional exports when resolving the dynamic import.
    const mod: Record<string, unknown> =
      config?.moduleSpecifier === "modbus-rs/web"
        ? yield* Effect.promise(() => import("modbus-rs/web"))
        : yield* Effect.promise(() => import("modbus-rs"));
    const TC = mod[transportKey];
    const toEffectClient = (config?.toEffectClient ?? makeEffectModbusClient) as unknown as (
      client: TClient,
    ) => EffectModbusClient;

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
        return toEffectClient(client);
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
