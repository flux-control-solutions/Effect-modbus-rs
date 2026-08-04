import { Deferred, Effect, Exit, Option, Ref, Scope } from 'effect';

import { type ModbusError, ModbusNotConnectedError, toModbusError } from './errors';
import {
  makeEffectModbusClient,
  type AnyModbusClient,
  type EffectModbusClient,
} from './modbus-client';

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
        work.pipe(
          Effect.onExit((exit) =>
            // Cleared before the deferred settles, so a waiter that immediately
            // calls again starts a new run instead of joining a finished one.
            Effect.zipRight(Ref.set(inFlight, Option.none()), Deferred.done(deferred, exit)),
          ),
        ),
      );
    }
    return yield* Deferred.await(deferred);
  });

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
  return Effect.fnUntraced(function* (options: TOptions) {
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
      try: () => openMethod(TC, options),
      catch: (error) => toModbusError(error as Error),
    }).pipe(
      Effect.tap((t) =>
        closed
          ? closeOrphan(t)
          : Effect.sync(() => {
              transport = t;
            }),
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
      if (!t) return Effect.void;
      return Effect.andThen(
        Effect.logDebug(`Closing ${serviceName}`),
        Effect.promise(() => t.close()),
      );
    });

    const notConnectedMsg = 'Transport is not connected. Call withClient() first.';

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
