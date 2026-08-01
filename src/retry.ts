import { Duration, Effect, Schedule } from 'effect';

import type { ModbusError } from './errors';

/**
 * The `_tag` of every {@link ModbusError} variant.
 *
 * Used to key per-error retry behaviour in
 * {@link ModbusRetryPolicyOptions.errors}.
 */
export type ModbusErrorTag = ModbusError['_tag'];

/**
 * Backoff curve for a single error category.
 *
 * The delay before retry _n_ (zero-based) is
 * `min(maxDelay, baseDelay * factor ** n)`, optionally jittered by the
 * policy-level {@link ModbusRetryPolicyOptions.jitter | jitter} setting.
 *
 * @see Schedule.exponential — The equivalent built-in Effect schedule.
 */
export interface RetryDelayOptions {
  /** Delay before the first retry. */
  readonly baseDelay?: Duration.DurationInput;
  /** Multiplier applied to the delay after each attempt. */
  readonly factor?: number;
  /** Upper bound on the delay, whatever the attempt count. */
  readonly maxDelay?: Duration.DurationInput;
}

/**
 * Per-error retry configuration.
 *
 * - `false` — never retry this error.
 * - `true` — retry using the policy-level backoff curve.
 * - {@link RetryDelayOptions} — retry using a curve specific to this error.
 */
export type RetryErrorOptions = boolean | RetryDelayOptions;

/**
 * Options accepted by {@link makeRetryPolicy} and by every preset in
 * {@link RetryPolicies}.
 *
 * Nothing here is applied automatically — a policy only takes effect where a
 * caller pipes an effect through {@link retryModbus} or
 * {@link retryModbusWithReconnect}. Library defaults stay single-shot so that
 * timing is predictable unless retries are explicitly opted into.
 */
export interface ModbusRetryPolicyOptions {
  /** Maximum number of retries (attempts = `maxRetries + 1`). Default `3`. */
  readonly maxRetries?: number;
  /** Wall-clock budget for the whole retry sequence. Unbounded by default. */
  readonly maxElapsed?: Duration.DurationInput;
  /**
   * Randomness applied to each delay, as a multiplier range.
   *
   * `true` (default) uses Effect's `0.8 – 1.2` range; `false` disables jitter;
   * an object customises the range. Jitter keeps a fleet of pollers from
   * re-hitting a recovering device in lockstep.
   *
   * @see Schedule.jitteredWith — The underlying combinator.
   */
  readonly jitter?: boolean | { readonly min?: number; readonly max?: number };
  /** Policy-level delay before the first retry. Default `100 millis`. */
  readonly baseDelay?: Duration.DurationInput;
  /** Policy-level backoff multiplier. Default `2`. */
  readonly factor?: number;
  /** Policy-level delay ceiling. Default `5 seconds`. */
  readonly maxDelay?: Duration.DurationInput;
  /**
   * Which {@link ModbusError} variants are retryable, with optional
   * per-error backoff overrides.
   *
   * Defaults retry the errors that a healthy bus recovers from on its own —
   * {@link ModbusTimeoutError}, {@link ModbusTransportError},
   * {@link ModbusConnectionClosedError}, and the transient exception codes in
   * {@link retryableExceptionCodes} — and never retry
   * {@link ModbusInvalidArgumentError}, {@link ModbusNotConnectedError}, or
   * {@link ModbusInternalError}.
   */
  readonly errors?: Partial<Record<ModbusErrorTag, RetryErrorOptions>>;
  /**
   * Modbus exception codes worth retrying when the device answers with an
   * exception response. Default {@link retryableExceptionCodes}.
   *
   * Only consulted when `ModbusExceptionError` is retryable at all.
   */
  readonly retryableExceptions?: ReadonlyArray<number>;
  /**
   * Errors that should trigger a transport `reconnect()` before the next
   * attempt when used with {@link retryModbusWithReconnect}.
   * Default `["ModbusConnectionClosedError"]`.
   */
  readonly reconnectOn?: ReadonlyArray<ModbusErrorTag>;
}

/**
 * A resolved retry policy: a schedule plus the predicates that produced it.
 *
 * Produced by {@link makeRetryPolicy} or a {@link RetryPolicies} preset, and
 * consumed by {@link retryModbus} / {@link retryModbusWithReconnect}. The
 * `schedule` is a plain Effect `Schedule`, so it can also be handed straight
 * to `Effect.retry`, `Effect.repeat`, or `Stream.retry`.
 */
export interface ModbusRetryPolicy {
  /**
   * Schedule driving the retries. Its input is the failing {@link ModbusError},
   * its output the `[retryIndex, error]` pair that produced the delay.
   */
  readonly schedule: Schedule.Schedule<[number, ModbusError], ModbusError>;
  /** Whether this policy retries the given error at all. */
  readonly isRetryable: (error: ModbusError) => boolean;
  /** Whether this error should trigger a transport reconnect before retrying. */
  readonly shouldReconnect: (error: ModbusError) => boolean;
}

/**
 * Modbus exception codes retried by default.
 *
 * These are the codes that mean "ask again later" rather than "your request is
 * wrong": `5` ACKNOWLEDGE, `6` SERVER_DEVICE_BUSY,
 * `10` GATEWAY_PATH_UNAVAILABLE, `11` GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND.
 *
 * Codes such as `1` ILLEGAL_FUNCTION, `2` ILLEGAL_DATA_ADDRESS, and
 * `3` ILLEGAL_DATA_VALUE are deterministic — retrying them only adds bus
 * traffic and latency.
 */
export const retryableExceptionCodes: ReadonlyArray<number> = [5, 6, 10, 11];

const defaultRetryableTags: Record<ModbusErrorTag, boolean> = {
  ModbusTimeoutError: true,
  ModbusTransportError: true,
  ModbusConnectionClosedError: true,
  ModbusExceptionError: true,
  ModbusInvalidArgumentError: false,
  ModbusNotConnectedError: false,
  ModbusInternalError: false,
};

const allTags = Object.keys(defaultRetryableTags) as ReadonlyArray<ModbusErrorTag>;

interface ResolvedDelay {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
}

const toMillis = (input: Duration.DurationInput): number =>
  Duration.toMillis(Duration.decode(input));

/** Resolves which error tags are retryable, defaults filled in per tag. */
const resolveRetryableTags = (
  options: ModbusRetryPolicyOptions,
): Record<ModbusErrorTag, boolean> => {
  const retryable = {} as Record<ModbusErrorTag, boolean>;
  for (const tag of allTags) {
    const entry = options.errors?.[tag];
    retryable[tag] = entry === undefined ? defaultRetryableTags[tag] : entry !== false;
  }
  return retryable;
};

/** Library-wide backoff curve, used where neither the policy nor an error overrides it. */
const defaultCurve: ResolvedDelay = { baseMs: 100, factor: 2, maxMs: 5_000 };

/** Layers a set of curve overrides onto a fallback curve. */
const resolveCurve = (overrides: RetryDelayOptions, fallback: ResolvedDelay): ResolvedDelay => ({
  baseMs: overrides.baseDelay === undefined ? fallback.baseMs : toMillis(overrides.baseDelay),
  factor: overrides.factor ?? fallback.factor,
  maxMs: overrides.maxDelay === undefined ? fallback.maxMs : toMillis(overrides.maxDelay),
});

/** Resolves the backoff curve for each error tag, layering per-error overrides. */
const resolveDelays = (
  options: ModbusRetryPolicyOptions,
): Record<ModbusErrorTag, ResolvedDelay> => {
  const policyCurve = resolveCurve(options, defaultCurve);
  const delays = {} as Record<ModbusErrorTag, ResolvedDelay>;
  for (const tag of allTags) {
    const entry = options.errors?.[tag];
    delays[tag] = resolveCurve(typeof entry === 'object' ? entry : {}, policyCurve);
  }
  return delays;
};

/**
 * Merges preset options with caller overrides.
 *
 * Top-level keys are replaced wholesale; `errors` is merged one level deep so
 * that overriding a single error tag does not discard the preset's tuning for
 * the others.
 */
const mergeOptions = (
  base: ModbusRetryPolicyOptions,
  overrides: ModbusRetryPolicyOptions | undefined,
): ModbusRetryPolicyOptions =>
  overrides === undefined
    ? base
    : {
        ...base,
        ...overrides,
        ...(base.errors || overrides.errors
          ? { errors: { ...base.errors, ...overrides.errors } }
          : {}),
      };

/**
 * Builds a {@link ModbusRetryPolicy} from {@link ModbusRetryPolicyOptions}.
 *
 * The resulting schedule is exponential, jittered, capped per error category,
 * and bounded by `maxRetries` (and `maxElapsed`, when set). The retry budget is
 * shared across error categories — only the delay curve is per-error — so an
 * operation that fails with a mix of timeouts and transport errors still stops
 * after `maxRetries` retries.
 *
 * @param options - Policy configuration. Defaults to a general-purpose policy:
 *   3 retries, `100 millis` base, factor `2`, `5 seconds` ceiling, jittered.
 * @returns A resolved policy for {@link retryModbus} /
 *   {@link retryModbusWithReconnect}.
 *
 * @example
 * ```ts
 * const policy = makeRetryPolicy({
 *   maxRetries: 5,
 *   baseDelay: "50 millis",
 *   errors: { ModbusExceptionError: false },
 * });
 * ```
 *
 * @see RetryPolicies — Ready-made templates built on top of this factory.
 */
export const makeRetryPolicy = (options: ModbusRetryPolicyOptions = {}): ModbusRetryPolicy => {
  const retryable = resolveRetryableTags(options);
  const delays = resolveDelays(options);
  const exceptions = options.retryableExceptions ?? retryableExceptionCodes;
  const reconnectTags = options.reconnectOn ?? ['ModbusConnectionClosedError'];

  const isRetryable = (error: ModbusError): boolean => {
    if (!retryable[error._tag]) return false;
    // Exception responses are only transient for a handful of codes — the rest
    // describe a request the device will reject identically every time.
    if (error._tag === 'ModbusExceptionError') return exceptions.includes(error.exception);
    return true;
  };

  const shouldReconnect = (error: ModbusError): boolean => reconnectTags.includes(error._tag);

  const delayFor = (error: ModbusError, retryIndex: number): Duration.Duration => {
    const { baseMs, factor, maxMs } = delays[error._tag];
    return Duration.millis(Math.min(maxMs, baseMs * factor ** retryIndex));
  };

  const base = Schedule.recurs(options.maxRetries ?? 3).pipe(
    // `identity` carries the failing error into the schedule output so the
    // delay can be chosen per error category; `recurs` supplies the counter
    // and the shared attempt budget.
    Schedule.intersect(Schedule.identity<ModbusError>()),
    Schedule.modifyDelay(([retryIndex, error]) => delayFor(error, retryIndex)),
    Schedule.whileInput(isRetryable),
  );

  const jitter = options.jitter ?? true;
  const jittered =
    jitter === false ? base : Schedule.jitteredWith(base, jitter === true ? {} : jitter);

  const schedule =
    options.maxElapsed === undefined ? jittered : Schedule.upTo(jittered, options.maxElapsed);

  return { schedule, isRetryable, shouldReconnect };
};

/**
 * Retry templates for common deployments.
 *
 * Each entry is a factory taking optional overrides, so a template can be used
 * as-is or as a starting point:
 *
 * ```ts
 * RetryPolicies.serial();
 * RetryPolicies.serial({ maxRetries: 6 });
 * ```
 *
 * None of these are applied implicitly — pick one and pipe through
 * {@link retryModbus}.
 */
export const RetryPolicies = {
  /**
   * No retries — the library default behaviour, stated explicitly.
   *
   * Useful as a base for opting individual call sites out of an
   * application-wide policy.
   */
  none: (overrides?: ModbusRetryPolicyOptions): ModbusRetryPolicy =>
    makeRetryPolicy(mergeOptions({ maxRetries: 0 }, overrides)),

  /**
   * Serial (RTU/ASCII) buses: short delays, tight ceiling.
   *
   * A framing or CRC error on RS-485 is usually a collision or a noise burst,
   * so retrying quickly is the right move; timeouts back off a little further
   * to let a slow device finish its turnaround. Reconnects are reserved for a
   * genuinely closed port — reopening a USB serial adapter is expensive.
   */
  serial: (overrides?: ModbusRetryPolicyOptions): ModbusRetryPolicy =>
    makeRetryPolicy(
      mergeOptions(
        {
          maxRetries: 3,
          baseDelay: '50 millis',
          factor: 2,
          maxDelay: '1 second',
          errors: { ModbusTimeoutError: { baseDelay: '100 millis' } },
          reconnectOn: ['ModbusConnectionClosedError'],
        },
        overrides,
      ),
    ),

  /**
   * Modbus/TCP: room for a TCP handshake to re-establish.
   *
   * A transport error over TCP generally means the socket is gone rather than
   * a corrupted frame, so it reconnects alongside an explicit connection close.
   */
  tcp: (overrides?: ModbusRetryPolicyOptions): ModbusRetryPolicy =>
    makeRetryPolicy(
      mergeOptions(
        {
          maxRetries: 4,
          baseDelay: '100 millis',
          factor: 2,
          maxDelay: '5 seconds',
          errors: {
            ModbusConnectionClosedError: { baseDelay: '250 millis', maxDelay: '10 seconds' },
          },
          reconnectOn: ['ModbusConnectionClosedError', 'ModbusTransportError'],
        },
        overrides,
      ),
    ),

  /**
   * Long-running background polling: keep trying, but stop hammering.
   *
   * Backs off to a 30-second ceiling and gives up after 5 minutes of failures
   * so a permanently dead device surfaces as an error instead of silently
   * retrying forever.
   */
  persistent: (overrides?: ModbusRetryPolicyOptions): ModbusRetryPolicy =>
    makeRetryPolicy(
      mergeOptions(
        {
          maxRetries: 10,
          baseDelay: '250 millis',
          factor: 2,
          maxDelay: '30 seconds',
          maxElapsed: '5 minutes',
          reconnectOn: ['ModbusConnectionClosedError', 'ModbusTransportError'],
        },
        overrides,
      ),
    ),
} as const;

/**
 * Applies a {@link ModbusRetryPolicy} to an effect.
 *
 * Errors the policy considers non-retryable fail through immediately, so an
 * `ModbusInvalidArgumentError` still surfaces on the first attempt under a
 * policy tuned for flaky wiring.
 *
 * @param policy - The policy to apply.
 * @returns A combinator that can be piped over any effect failing with
 *   {@link ModbusError}.
 *
 * @example
 * ```ts
 * const registers = yield* client
 *   .readHoldingRegisters({ address: 0, quantity: 10 })
 *   .pipe(retryModbus(RetryPolicies.serial()));
 * ```
 */
export const retryModbus =
  (policy: ModbusRetryPolicy) =>
  <A, E extends ModbusError, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.retry(self, policy.schedule);

/**
 * The slice of a transport service {@link retryModbusWithReconnect} needs.
 *
 * Every transport service in this package (`RtuTransportService`,
 * `AsciiTransportService`, `TcpTransportService`, and the `Wasm*` variants)
 * satisfies it.
 */
export interface ReconnectableTransport {
  /** Reconnects the transport. */
  reconnect(): Effect.Effect<void, ModbusError>;
}

/**
 * Applies a {@link ModbusRetryPolicy}, reconnecting the transport first for
 * the errors the policy marks with
 * {@link ModbusRetryPolicyOptions.reconnectOn | reconnectOn}.
 *
 * This replaces the hand-rolled `catchTags` + `reconnect` + `fail` dance in
 * long-running pollers. The reconnect runs immediately after the failing
 * attempt and before the backoff delay, and a failed reconnect is ignored —
 * the next attempt will report the real error.
 *
 * Note that the reconnect also runs after the final attempt, which leaves the
 * transport repaired for whatever the caller does next.
 *
 * @param transport - The transport service backing the effect.
 * @param policy - The policy to apply.
 * @returns A combinator that can be piped over any effect failing with
 *   {@link ModbusError}.
 *
 * @example
 * ```ts
 * const transport = yield* TcpTransportService;
 * const client = yield* transport.withClient(1);
 * const registers = yield* client
 *   .readHoldingRegisters({ address: 0, quantity: 10 })
 *   .pipe(retryModbusWithReconnect(transport, RetryPolicies.tcp()));
 * ```
 */
export const retryModbusWithReconnect =
  (transport: ReconnectableTransport, policy: ModbusRetryPolicy) =>
  <A, E extends ModbusError, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.retry(
      Effect.tapError(self, (error: E) =>
        policy.shouldReconnect(error) && policy.isRetryable(error)
          ? Effect.ignore(transport.reconnect())
          : Effect.void,
      ),
      policy.schedule,
    );
