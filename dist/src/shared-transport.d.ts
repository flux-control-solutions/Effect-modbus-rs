import { Effect, Scope } from "effect";
import { type ModbusError, ModbusNotConnectedError } from "./errors";
import { type AnyModbusClient, type EffectModbusClient } from "./modbus-client";
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
    createClient(opts: {
        unitId: number;
    }): TClient;
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
export declare function makeTransportScoped<TOptions, TClient extends AnyModbusClient, TTransport extends TransportHandle<TClient>>(transportKey: string, openMethod: (TC: unknown, options: TOptions) => Promise<TTransport>, serviceName: string): (options: TOptions) => Effect.Effect<{
    withClient: (unitId: number) => Effect.Effect<EffectModbusClient, ModbusError, never>;
    setRequestTimeout: (timeoutMs: number) => Effect.Effect<undefined, ModbusNotConnectedError, never>;
    clearRequestTimeout: () => Effect.Effect<undefined, ModbusNotConnectedError, never>;
    reconnect: () => Effect.Effect<undefined, ModbusError, never>;
    close: () => Effect.Effect<void, ModbusError, Scope.Scope>;
    hasPendingRequests: () => boolean;
}, never, Scope.Scope>;
export {};
