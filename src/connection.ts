import { Data, Duration, Effect, Either, SubscriptionRef } from 'effect';

import { ModbusCircuitOpenError, type ModbusError } from './errors';
import { makeRetryPolicy, retryModbus, type ModbusErrorTag, type ModbusRetryPolicy } from './retry';

/**
 * Live connection state of a transport.
 *
 * Owned by the transport and published through
 * {@link TransportServiceApi.connectionState}, so an application can show link
 * status without inferring it from failed reads.
 *
 * - `Disconnected` — never opened, or closed. Operations open it lazily.
 * - `Connected` — usable.
 * - `Reconnecting` — the supervisor is re-establishing the link. Operations are
 *   refused with {@link ModbusCircuitOpenError} rather than queued on a dead bus.
 * - `Down` — reconnect attempts were exhausted; the supervisor is waiting out
 *   `resetAfter` before probing again. Operations are refused.
 */
export type ConnectionState = Data.TaggedEnum<{
  Disconnected: object;
  Connected: object;
  Reconnecting: { readonly attempt: number };
  Down: { readonly cause: ModbusError };
}>;

/** Constructors and matchers for {@link ConnectionState}. */
export const ConnectionState = Data.taggedEnum<ConnectionState>();

/**
 * Transport-level reconnection and circuit-breaking configuration.
 *
 * Supplying this on a transport hands reconnection to a supervisor fiber owned
 * by that transport: one reconnect for the whole application rather than one
 * per failing call site. Omit it and the transport keeps its manual behaviour —
 * `reconnect()` still works, nothing happens on its own.
 */
export interface ReconnectOptions {
  /**
   * How reconnect attempts are spaced. Defaults to 5 attempts, `250 millis`
   * base, factor 2, `10 seconds` ceiling, jittered.
   */
  readonly policy?: ModbusRetryPolicy;
  /**
   * How long the circuit stays open after attempts are exhausted, before the
   * supervisor probes again. Default `30 seconds`.
   */
  readonly resetAfter?: Duration.DurationInput;
  /**
   * Which operation failures hand control to the supervisor.
   * Default `["ModbusConnectionClosedError", "ModbusTransportError"]`.
   */
  readonly triggerOn?: ReadonlyArray<ModbusErrorTag>;
}

/** {@link ReconnectOptions} with defaults applied. */
export interface ResolvedReconnect {
  readonly policy: ModbusRetryPolicy;
  readonly resetAfter: Duration.Duration;
  readonly triggers: (error: ModbusError) => boolean;
}

/** Default spacing for reconnect attempts — slower and longer than an operation retry. */
const defaultReconnectPolicy = makeRetryPolicy({
  maxRetries: 5,
  baseDelay: '250 millis',
  factor: 2,
  maxDelay: '10 seconds',
});

const defaultTriggers: ReadonlyArray<ModbusErrorTag> = [
  'ModbusConnectionClosedError',
  'ModbusTransportError',
];

/** Applies defaults to {@link ReconnectOptions}. */
export const resolveReconnect = (options: ReconnectOptions): ResolvedReconnect => {
  const triggerTags = options.triggerOn ?? defaultTriggers;
  return {
    policy: options.policy ?? defaultReconnectPolicy,
    resetAfter: Duration.decode(options.resetAfter ?? '30 seconds'),
    triggers: (error) => triggerTags.includes(error._tag),
  };
};

/**
 * Refuses an operation while the link is being re-established.
 *
 * `Disconnected` is allowed through so the first call still opens the
 * transport lazily; only `Reconnecting` and `Down` are refused.
 *
 * @param state - The transport's connection state.
 * @returns An Effect failing with {@link ModbusCircuitOpenError} when the
 *   circuit is open, and succeeding otherwise.
 */
export const guardCircuit = (
  state: SubscriptionRef.SubscriptionRef<ConnectionState>,
): Effect.Effect<void, ModbusCircuitOpenError> =>
  Effect.flatMap(SubscriptionRef.get(state), (current) =>
    ConnectionState.$match(current, {
      Disconnected: () => Effect.void,
      Connected: () => Effect.void,
      Reconnecting: ({ attempt }) =>
        Effect.fail(
          new ModbusCircuitOpenError({
            cause: new Error('Transport is reconnecting'),
            message: `Transport is reconnecting (attempt ${attempt}); request refused`,
          }),
        ),
      Down: ({ cause }) =>
        Effect.fail(
          new ModbusCircuitOpenError({
            cause: cause.cause,
            message: `Transport is down (${cause.message}); request refused`,
          }),
        ),
    }),
  );

/**
 * The supervisor loop: re-establishes the link, then keeps probing for as long
 * as the transport lives.
 *
 * Each round runs `reconnect` under the configured policy. Success publishes
 * `Connected` and ends the loop; exhausting the policy publishes `Down` and
 * waits out `resetAfter` before the next round, so an unplugged device is
 * retried at a steady cadence instead of being hammered or given up on.
 *
 * @param reconnect - The transport's own reconnect operation.
 * @param state - The state cell to publish transitions to.
 * @param resolved - Reconnect configuration with defaults applied.
 * @returns An Effect that runs until the link is restored.
 */
export const superviseReconnect = (
  reconnect: Effect.Effect<void, ModbusError>,
  state: SubscriptionRef.SubscriptionRef<ConnectionState>,
  resolved: ResolvedReconnect,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const attempt = reconnect.pipe(
        Effect.tapError(() =>
          SubscriptionRef.update(state, (current) =>
            ConnectionState.$is('Reconnecting')(current)
              ? ConnectionState.Reconnecting({ attempt: current.attempt + 1 })
              : current,
          ),
        ),
        retryModbus(resolved.policy),
      );

      const result = yield* Effect.either(attempt);
      if (Either.isRight(result)) {
        yield* SubscriptionRef.set(state, ConnectionState.Connected());
        return;
      }

      yield* Effect.logDebug(`Reconnect attempts exhausted: ${result.left.message}`);
      yield* SubscriptionRef.set(state, ConnectionState.Down({ cause: result.left }));
      yield* Effect.sleep(resolved.resetAfter);
      yield* SubscriptionRef.set(state, ConnectionState.Reconnecting({ attempt: 0 }));
    }
  });
