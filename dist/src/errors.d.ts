declare const ModbusExceptionError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusExceptionError";
} & Readonly<A>;
/**
 * Error originating from a Modbus protocol exception response.
 *
 * Mapped from {@link ModbusErrorCode.EXCEPTION} via `modbus-rs`.
 * The {@link exception} field holds the Modbus exception code
 * (e.g. 1 = ILLEGAL_FUNCTION, 2 = ILLEGAL_DATA_ADDRESS, 3 = ILLEGAL_DATA_VALUE).
 *
 * @see ModbusErrorCode.EXCEPTION — `modbus-rs` error code that triggers this error.
 */
export declare class ModbusExceptionError extends ModbusExceptionError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Parsed Modbus exception code extracted from the error message. */
    readonly exception: number;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusTimeoutError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusTimeoutError";
} & Readonly<A>;
/**
 * Error indicating a request timed out while waiting for a response.
 *
 * Mapped from {@link ModbusErrorCode.TIMEOUT} via `modbus-rs`.
 * Adjust timeouts via `setRequestTimeout` on the transport, or configure
 * with {@link RtuTransportOptions.requestTimeoutMs | requestTimeoutMs} /
 * {@link RtuTransportOptions.responseTimeoutMs | responseTimeoutMs}.
 *
 * @see ModbusErrorCode.TIMEOUT — `modbus-rs` error code that triggers this error.
 */
export declare class ModbusTimeoutError extends ModbusTimeoutError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusTransportError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusTransportError";
} & Readonly<A>;
/**
 * Error indicating a transport-level failure (framing, CRC, or I/O error).
 *
 * Mapped from {@link ModbusErrorCode.TRANSPORT} via `modbus-rs`.
 * Common causes: serial port issues, wiring problems, or baud rate mismatch.
 *
 * @see ModbusErrorCode.TRANSPORT — `modbus-rs` error code that triggers this error.
 */
export declare class ModbusTransportError extends ModbusTransportError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusInvalidArgumentError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusInvalidArgumentError";
} & Readonly<A>;
/**
 * Error indicating an invalid argument was passed to a Modbus API call.
 *
 * Mapped from {@link ModbusErrorCode.INVALID_ARGUMENT} via `modbus-rs`.
 * Typically thrown when register/coil addresses or quantities are out of range.
 *
 * @see ModbusErrorCode.INVALID_ARGUMENT — `modbus-rs` error code that triggers this error.
 */
export declare class ModbusInvalidArgumentError extends ModbusInvalidArgumentError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusConnectionClosedError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusConnectionClosedError";
} & Readonly<A>;
/**
 * Error indicating the transport connection was closed unexpectedly.
 *
 * Mapped from {@link ModbusErrorCode.CONNECTION_CLOSED} via `modbus-rs`.
 * The transport can be re-established using `reconnect()` on the transport service.
 *
 * @see ModbusErrorCode.CONNECTION_CLOSED — `modbus-rs` error code that triggers this error.
 */
export declare class ModbusConnectionClosedError extends ModbusConnectionClosedError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusInternalError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusInternalError";
} & Readonly<A>;
/**
 * Error indicating an internal library error not covered by other categories.
 *
 * Mapped from any unrecognized error code returned by
 * {@link getModbusErrorCode} (acts as the catch-all fallback).
 *
 * @see ModbusErrorCode.INTERNAL — `modbus-rs` error code for internal failures.
 */
export declare class ModbusInternalError extends ModbusInternalError_base<{
    /** Original error thrown by `modbus-rs`. */
    readonly cause: Error;
    /** Error message from the underlying `modbus-rs` error. */
    readonly message: string;
}> {
}
declare const ModbusNotConnectedError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ModbusNotConnectedError";
} & Readonly<A>;
/**
 * Error indicating a transport operation was attempted before the
 * connection was established or after it was closed.
 *
 * This is a **local** error — it is never returned by `modbus-rs`.
 * It is thrown by the transport service when `setRequestTimeout`,
 * `clearRequestTimeout`, or `withClient` is called before a
 * successful connection.
 *
 * Connect by calling `withClient(unitId)` on the transport service.
 * The connection is established lazily on the first call.
 *
 * @see ModbusNotConnectedError — Triggered when the transport is null.
 */
export declare class ModbusNotConnectedError extends ModbusNotConnectedError_base<{
    /** The original cause (typically a descriptive error). */
    readonly cause: Error;
    /** Human-readable explanation of the error. */
    readonly message: string;
}> {
}
/**
 * Union of all typed Modbus errors emitted by this library.
 *
 * Handle with {@linkcode Effect.catchTags}:
 *
 * ```ts
 * Effect.catchTags(client.readHoldingRegisters({ address: 0, quantity: 10 }), {
 *   ModbusTimeoutError: () => ...,
 *   ModbusTransportError: () => ...,
 *   ModbusExceptionError: (e) => ...,
 * })
 * ```
 *
 * Each variant maps to a specific {@link ModbusErrorCode} from `modbus-rs`.
 *
 * @see ModbusErrorCode — The upstream error code enum driving this mapping.
 */
export type ModbusError = ModbusExceptionError | ModbusTimeoutError | ModbusTransportError | ModbusInvalidArgumentError | ModbusConnectionClosedError | ModbusNotConnectedError | ModbusInternalError;
/**
 * Converts a raw `Error` from `modbus-rs` into a typed {@link ModbusError}.
 *
 * Uses {@link getModbusErrorCode} to classify the error by its internal
 * error code, then constructs the appropriate `Data.TaggedError` variant.
 * Unknown/unrecognized codes fall through to {@link ModbusInternalError}.
 *
 * @param cause - The raw `Error` thrown by a `modbus-rs` API call.
 * @returns A typed `ModbusError` variant matching the error code.
 *
 * @see getModbusErrorCode — Upstream function that extracts the error discriminant.
 * @see ModbusErrorCode — Enum of possible error codes.
 */
export declare const toModbusError: (cause: Error) => ModbusError;
export {};
