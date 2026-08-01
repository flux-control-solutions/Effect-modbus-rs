import { Data } from 'effect';
import { getModbusErrorCode, ModbusErrorCode } from 'modbus-rs';

/**
 * Error originating from a Modbus protocol exception response.
 *
 * Mapped from {@link ModbusErrorCode.EXCEPTION} via `modbus-rs`.
 * The {@link exception} field holds the Modbus exception code
 * (e.g. 1 = ILLEGAL_FUNCTION, 2 = ILLEGAL_DATA_ADDRESS, 3 = ILLEGAL_DATA_VALUE).
 *
 * @see ModbusErrorCode.EXCEPTION — `modbus-rs` error code that triggers this error.
 */
export class ModbusExceptionError extends Data.TaggedError('ModbusExceptionError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Parsed Modbus exception code extracted from the error message. */
  readonly exception: number;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

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
export class ModbusTimeoutError extends Data.TaggedError('ModbusTimeoutError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

/**
 * Error indicating a transport-level failure (framing, CRC, or I/O error).
 *
 * Mapped from {@link ModbusErrorCode.TRANSPORT} via `modbus-rs`.
 * Common causes: serial port issues, wiring problems, or baud rate mismatch.
 *
 * @see ModbusErrorCode.TRANSPORT — `modbus-rs` error code that triggers this error.
 */
export class ModbusTransportError extends Data.TaggedError('ModbusTransportError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

/**
 * Error indicating an invalid argument was passed to a Modbus API call.
 *
 * Mapped from {@link ModbusErrorCode.INVALID_ARGUMENT} via `modbus-rs`.
 * Typically thrown when register/coil addresses or quantities are out of range.
 *
 * @see ModbusErrorCode.INVALID_ARGUMENT — `modbus-rs` error code that triggers this error.
 */
export class ModbusInvalidArgumentError extends Data.TaggedError('ModbusInvalidArgumentError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

/**
 * Error indicating the transport connection was closed unexpectedly.
 *
 * Mapped from {@link ModbusErrorCode.CONNECTION_CLOSED} via `modbus-rs`.
 * The transport can be re-established using `reconnect()` on the transport service.
 *
 * @see ModbusErrorCode.CONNECTION_CLOSED — `modbus-rs` error code that triggers this error.
 */
export class ModbusConnectionClosedError extends Data.TaggedError('ModbusConnectionClosedError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

/**
 * Error indicating an internal library error not covered by other categories.
 *
 * Mapped from any unrecognized error code returned by
 * {@link getModbusErrorCode} (acts as the catch-all fallback).
 *
 * @see ModbusErrorCode.INTERNAL — `modbus-rs` error code for internal failures.
 */
export class ModbusInternalError extends Data.TaggedError('ModbusInternalError')<{
  /** Original error thrown by `modbus-rs`. */
  readonly cause: Error;
  /** Error message from the underlying `modbus-rs` error. */
  readonly message: string;
}> {}

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
export class ModbusNotConnectedError extends Data.TaggedError('ModbusNotConnectedError')<{
  /** The original cause (typically a descriptive error). */
  readonly cause: Error;
  /** Human-readable explanation of the error. */
  readonly message: string;
}> {}

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
export type ModbusError =
  | ModbusExceptionError
  | ModbusTimeoutError
  | ModbusTransportError
  | ModbusInvalidArgumentError
  | ModbusConnectionClosedError
  | ModbusNotConnectedError
  | ModbusInternalError;

/**
 * Extracts a Modbus exception code from an error message string.
 *
 * The upstream `modbus-rs` library embeds exception codes in its error
 * messages using the pattern `[MODBUS_EXCEPTION:<code>]`.
 *
 * @param message - The error message from a `modbus-rs` exception error.
 * @returns The parsed exception code, or `undefined` if no match is found.
 */
function parseExceptionCode(message: string): number | undefined {
  const m = message.match(/\[MODBUS_EXCEPTION:(\d+)\]/);
  return m ? Number(m[1]) : undefined;
}

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
export const toModbusError = (cause: Error): ModbusError => {
  const code = getModbusErrorCode(cause);
  const message = cause.message;
  switch (code) {
    case ModbusErrorCode.EXCEPTION:
      return new ModbusExceptionError({
        cause,
        exception: parseExceptionCode(message) ?? 0,
        message,
      });
    case ModbusErrorCode.TIMEOUT:
      return new ModbusTimeoutError({ cause, message });
    case ModbusErrorCode.TRANSPORT:
      return new ModbusTransportError({ cause, message });
    case ModbusErrorCode.INVALID_ARGUMENT:
      return new ModbusInvalidArgumentError({ cause, message });
    case ModbusErrorCode.CONNECTION_CLOSED:
      return new ModbusConnectionClosedError({ cause, message });
    default:
      return new ModbusInternalError({ cause, message });
  }
};
