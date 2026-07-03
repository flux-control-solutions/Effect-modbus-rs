import type { SerialServerOptions, ServerHandlers } from "modbus-rs";
import { Layer } from "effect";
import type { ModbusError } from "./errors";
/**
 * A scoped {@link Layer} that starts a Modbus serial RTU server.
 *
 * @param options - Serial port options (path, baud rate, unit ID, etc.).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { serialRtuServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = serialRtuServerLayer(
 *   { portPath: "/dev/ttyUSB0", baudRate: 9600, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see SerialServerOptions — Options accepted by the upstream serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export declare const serialRtuServerLayer: (options: SerialServerOptions, handlers: ServerHandlers) => Layer.Layer<never, ModbusError>;
/**
 * A scoped {@link Layer} that starts a Modbus serial ASCII server.
 *
 * @param options - Serial port options (path, baud rate, unit ID, etc.).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { serialAsciiServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = serialAsciiServerLayer(
 *   { portPath: "/dev/ttyUSB0", baudRate: 9600, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see SerialServerOptions — Options accepted by the upstream serial server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export declare const serialAsciiServerLayer: (options: SerialServerOptions, handlers: ServerHandlers) => Layer.Layer<never, ModbusError>;
