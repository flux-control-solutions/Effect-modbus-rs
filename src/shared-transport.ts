import { Deferred, Effect, Exit, Option, Ref, Scope, SubscriptionRef } from 'effect';

import {
  ConnectionState,
  resolveReconnect,
  guardCircuit,
  superviseReconnect,
  type ReconnectOptions,
} from './connection';
import { type ModbusError, ModbusNotConnectedError, toModbusError } from './errors';
import {
  makeEffectModbusClient,
  withResilience,
  type AnyModbusClient,
  type EffectModbusClient,
} from './modbus-client';
import type { ModbusRetryPolicy } from './retry';

/**
 * Resilience configuration accepted by every transport service alongside its
 * `modbus-rs` options.
 *
 * Both are opt-in: with neither set, a transport behaves exactly as it always
 * has — one attempt per operation, reconnection only when asked for.
 */
export interface TransportResilienceOptions {
  /**
   * Retry policy applied to every operation of every client from this
   * transport. Overridable per client and per operation.
   */
  readonly retry?: ModbusRetryPolicy;
  /**
   * Hands reconnection to a supervisor fiber owned by this transport, and
   * enables the circuit breaker that keeps callers off a dead bus.
   */
  readonly reconnect?: ReconnectOptions;
}

/** Cell holding the in-flight operation of a {@link singleFlight} group, if any. */
type InFlight<A> = Ref.Ref<Option.Option<Deferred.Deferred<A, ModbusError>>>;

/**
 * Result of electing a leader: the {@link Deferred} to await plus whether this
 * caller drew the short straw, paired with the cell's next value.
 */
type Election<A> = readonly [
  readonly [Deferred.Deferred<A, ModbusError>, boolean],
  Option.Option<Deferred.Deferred<A, ModbusError>>,
];

/** Creates the state cell for a {@link singleFlight} group. */
const makeInFlight = <A>(): Effect.Effect<InFlight<A>> =>
  Ref.make(Option.none<Deferred.Deferred<A, ModbusError>>());

/**
 * Runs `work` at most once at a time, with every concurrent caller observing
 * the same result.
 *
 * The first caller to arrive becomes the leader and forks `work`; later callers
 * await the leader's {@link Deferred} instead of starting their own run. The
 * work is forked as a daemon rather than run by the leader directly, so
 * interrupting any individual caller — a poller being torn down, say — can
 * neither cancel the shared operation nor strand the fibers waiting on it.
 *
 * The cell is cleared as the work settles, so a failure is shared by everyone
 * waiting on that run and the next call starts a fresh one.
 *
 * @param inFlight - State cell shared by the callers being coalesced.
 * @param work - The operation to run at most once at a time.
 * @returns An Effect resolving to the shared result.
 */
const singleFlight = <A>(
  inFlight: InFlight<A>,
  work: Effect.Effect<A, ModbusError>,
): Effect.Effect<A, ModbusError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fresh = yield* Deferred.make<A, ModbusError>();
      const [deferred, isLeader] = yield* Ref.modify(
        inFlight,
        (current): Election<A> =>
          Option.match(current, {
            onSome: (existing) => [[existing, false], current],
            onNone: () => [[fresh, true], Option.some(fresh)],
          }),
      );
      if (isLeader) {
        yield* Effect.forkDaemon(
          Effect.interruptible(work).pipe(
            Effect.onExit((exit) =>
              // Cleared before the deferred settles, so a waiter that immediately
              // calls again starts a new run instead of joining a finished one.
              Effect.zipRight(Ref.set(inFlight, Option.none()), Deferred.done(deferred, exit)),
            ),
          ),
        );
      }
      return yield* restore(Deferred.await(deferred));
    }),
  );

/**
 * Shared API surface that every transport service exposes to consumers.
 *
 * Provides lazy connection, per-unit-ID client caching, timeout management,
 * reconnection, and graceful shutdown — all within the Effect scope.
 *
 * @see makeTransportScoped — Factory that produces this API from a raw transport.
 */
export interface TransportServiceApi {
  /**
   * Obtains an {@link EffectModbusClient} for the given unit ID.
   *
   * The client carries the transport's retry policy unless `options.retry`
   * replaces it — useful when one bus hosts device types that need different
   * logic. The underlying `modbus-rs` client is cached per unit ID, so clients
   * built with different policies still share one connection.
   *
   * @param unitId - Modbus unit ID to address.
   * @param options - Per-client policy replacing the transport default.
   */
  withClient(
    unitId: number,
    options?: { readonly retry?: ModbusRetryPolicy },
  ): Effect.Effect<EffectModbusClient, ModbusError>;
  /**
   * Live connection state, published by the transport.
   *
   * Read it with `SubscriptionRef.get`, or subscribe with `.changes` to drive
   * a status indicator:
   *
   * ```ts
   * yield* Stream.runForEach(transport.connectionState.changes, (state) =>
   *   Console.log(`link: ${state._tag}`))
   * ```
   */
  readonly connectionState: SubscriptionRef.SubscriptionRef<ConnectionState>;
  /** Sets a request timeout (ms) on the underlying transport. Fails if not connected. */
  setRequestTimeout(timeoutMs: number): Effect.Effect<void, ModbusError>;
  /** Clears the request timeout. Fails if not connected. */
  clearRequestTimeout(): Effect.Effect<void, ModbusError>;
  /**
   * Reconnects the transport. Opens lazily if no prior connection exists.
   *
   * Concurrent calls are coalesced: fibers arriving while a reconnect is in
   * flight join it rather than starting another, and all of them observe its
   * result. Fails with `ModbusNotConnectedError` if the transport was closed
   * while the reconnect was running.
   */
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
 * @param config - Optional module specifier override for browser WASM transports.
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
    moduleSpecifier?: 'modbus-rs' | 'modbus-rs/web';
  },
) {
  return Effect.fnUntraced(function* (options: TOptions & TransportResilienceOptions) {
    // Resilience is this package's concern; only the rest reaches modbus-rs.
    const { retry: transportRetry, reconnect: reconnectOptions, ...rest } = options;
    const openOptions = rest as unknown as TOptions;
    // Branched as a literal specifier (not a variable) so bundlers reliably apply
    // modbus-rs's conditional exports when resolving the dynamic import.
    const mod: Record<string, unknown> =
      config?.moduleSpecifier === 'modbus-rs/web'
        ? yield* Effect.promise(() => import('modbus-rs/web'))
        : yield* Effect.promise(() => import('modbus-rs'));
    const TC = mod[transportKey];

    let transport: TTransport | null = null;

    const opening = yield* makeInFlight<TTransport>();
    const reconnecting = yield* makeInFlight<void>();
    const connectionState = yield* SubscriptionRef.make<ConnectionState>(
      ConnectionState.Disconnected(),
    );
    const supervised = reconnectOptions ? resolveReconnect(reconnectOptions) : null;
    // Captured here so the API's methods keep `R = never` while still being
    // able to fork the supervisor into the service's own lifetime.
    const serviceScope = yield* Effect.scope;

    const clientSet = new Map<number, TClient>();

    let closed = false;

    const transportClosed = () =>
      new ModbusNotConnectedError({
        cause: new Error('Transport has been closed'),
        message: 'Transport has been closed',
      });

    /**
     * Closes a handle nothing else will close: the scope finalizer has already
     * run, so an open/reconnect that landed afterwards owns its own cleanup.
     * Detached, since the caller is on its way to failing anyway.
     */
    const closeOrphan = (t: TTransport) =>
      Effect.forkDaemon(Effect.ignore(Effect.tryPromise(() => t.close())));

    // Assigning `transport` inside the shared work rather than in the caller
    // keeps the handle reachable — and therefore closeable — even if every
    // caller is interrupted before the connection completes.
    const openTransport = Effect.tryPromise({
      try: () => openMethod(TC, openOptions),
      catch: (error) => toModbusError(error as Error),
    }).pipe(
      Effect.tap((t) =>
        closed
          ? closeOrphan(t)
          : Effect.zipRight(
              Effect.sync(() => {
                transport = t;
              }),
              SubscriptionRef.set(connectionState, ConnectionState.Connected()),
            ),
      ),
    );

    const ensureOpen = Effect.fnUntraced(function* () {
      if (closed) return yield* transportClosed();
      if (transport) return transport;
      const t = yield* singleFlight(opening, openTransport);
      if (closed) return yield* transportClosed();
      return t;
    });

    yield* Effect.addFinalizer(() => {
      if (closed) return Effect.void;
      closed = true;
      const t = transport;
      if (!t) return SubscriptionRef.set(connectionState, ConnectionState.Disconnected());
      return Effect.andThen(
        Effect.logDebug(`Closing ${serviceName}`),
        Effect.zipRight(
          Effect.promise(() => t.close()),
          SubscriptionRef.set(connectionState, ConnectionState.Disconnected()),
        ),
      );
    });

    const notConnectedMsg = 'Transport is not connected. Call withClient() first.';

    /** The transport's own reconnect, as the supervisor drives it. */
    const reconnectOnce = Effect.suspend(() => {
      const t = transport;
      if (closed || !t) return transportClosed();
      return singleFlight(
        reconnecting,
        Effect.tryPromise({
          try: () => t.reconnect(),
          catch: (error) => toModbusError(error as Error),
        }).pipe(Effect.tap(() => (closed ? closeOrphan(t) : Effect.void))),
      );
    });

    /**
     * Hands a connection-level failure to the supervisor.
     *
     * The transition is claimed atomically, so of the fibers that fail together
     * exactly one starts the supervisor and the rest simply carry on failing —
     * one reconnect for the whole application, not one per call site.
     */
    const report = (error: ModbusError): Effect.Effect<void> => {
      if (!supervised || closed || !supervised.triggers(error)) return Effect.void;
      return Effect.gen(function* () {
        const claimed = yield* SubscriptionRef.modify(connectionState, (current) =>
          ConnectionState.$is('Connected')(current)
            ? [true, ConnectionState.Reconnecting({ attempt: 0 })]
            : [false, current],
        );
        if (!claimed) return;
        yield* Effect.logDebug(`${serviceName}: reconnecting after ${error.message}`);
        yield* Effect.forkIn(
          superviseReconnect(reconnectOnce, connectionState, supervised),
          serviceScope,
        );
      });
    };

    const resilience = {
      // Without a supervisor there is no breaker: nothing else would ever
      // close the circuit again.
      guard: supervised ? guardCircuit(connectionState) : Effect.void,
      report,
    };

    return {
      connectionState,

      withClient: Effect.fnUntraced(function* (
        unitId: number,
        clientOptions?: { readonly retry?: ModbusRetryPolicy },
      ) {
        const t = yield* ensureOpen();
        let client = clientSet.get(unitId);
        if (!client) {
          client = yield* Effect.try({
            try: () => t.createClient({ unitId }),
            catch: (error) => toModbusError(error as Error),
          });
          clientSet.set(unitId, client);
        }
        return withResilience(makeEffectModbusClient(client), {
          ...resilience,
          policy: clientOptions?.retry ?? transportRetry,
        });
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
        if (closed) return yield* transportClosed();
        const t = transport;
        if (!t) {
          yield* ensureOpen();
          return;
        }
        yield* singleFlight(
          reconnecting,
          Effect.tryPromise({
            try: () => t.reconnect(),
            catch: (error) => toModbusError(error as Error),
          }).pipe(
            // A reconnect that lands after the scope finalizer has closed the
            // transport has reopened a handle nobody owns.
            Effect.tap(() => (closed ? closeOrphan(t) : Effect.void)),
          ),
        );
        // Mirrors ensureOpen: report the closure rather than a success against
        // a transport that was torn down while the reconnect was in flight.
        if (closed) return yield* transportClosed();
        yield* SubscriptionRef.set(connectionState, ConnectionState.Connected());
      }),

      close: Effect.fnUntraced(function* () {
        if (closed) return;
        closed = true;
        yield* SubscriptionRef.set(connectionState, ConnectionState.Disconnected());
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
