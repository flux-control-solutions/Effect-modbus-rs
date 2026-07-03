import type { ServerHandlers, TcpServerOptions } from "modbus-rs";
import { Layer } from "effect";
import type { ModbusError } from "./errors";
/**
 * A scoped {@link Layer} that starts a Modbus TCP server.
 *
 * The server binds to the specified host and port, handling incoming
 * Modbus requests via the provided {@link ServerHandlers}. The connection
 * is automatically shut down when the consuming scope finalizes.
 *
 * @param options - Server bind options (host, port, unit ID).
 * @param handlers - Callback functions that handle incoming Modbus requests.
 * @returns A `Layer` that fails with {@link ModbusError} on bind failure.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import { tcpServerLayer } from "effect-modbus-rs";
 *
 * const ServerLive = tcpServerLayer(
 *   { host: "0.0.0.0", port: 502, unitId: 1 },
 *   { onReadCoils: (req) => [false, false] },
 * );
 *
 * Layer.launch(ServerLive).pipe(Effect.runPromise);
 * ```
 *
 * @see TcpServerOptions — Options accepted by the upstream TCP server.
 * @see ServerHandlers — Interface for request handler callbacks.
 */
export declare const tcpServerLayer: (options: TcpServerOptions, handlers: ServerHandlers) => Layer.Layer<never, ModbusError>;
