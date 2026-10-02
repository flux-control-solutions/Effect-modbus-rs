import { Effect } from 'effect';
import type { WasmSerialPortHandle } from 'modbus-rs/web';

import type { ModbusError } from './errors';
import { toModbusError } from './errors';

/**
 * Requests a browser serial port handle via the Web Serial API, for use with
 * {@link WasmSerialTransportService.fromRtu} / `.fromAscii` (or
 * `WasmRtuTransportService.make` / `WasmAsciiTransportService.make` directly).
 *
 * Call this from a browser user-gesture handler, such as a click handler, because
 * the Web Serial API may require transient user activation to show its chooser.
 * The helper loads the browser binding before requesting the port, so it does not
 * itself call the browser API synchronously in the handler.
 *
 * @example
 * ```ts
 * button.addEventListener("click", () => {
 *   Effect.runPromise(
 *     requestSerialPort().pipe(
 *       Effect.flatMap((port) => Effect.provide(program, WasmRtuTransportService.make({ port, baudRate: 19200 }))),
 *     ),
 *   );
 * });
 * ```
 *
 * @returns An effect that succeeds with the selected opaque port handle or fails
 *   with {@link ModbusError} when the browser request or binding fails.
 * @see WasmSerialPortHandle — Opaque handle returned by `modbus-rs`'s WASM bindings.
 */
export const requestSerialPort = (): Effect.Effect<WasmSerialPortHandle, ModbusError> =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import('modbus-rs/web');
      return mod.requestSerialPort();
    },
    catch: (error) => toModbusError(error instanceof Error ? error : new Error(String(error))),
  });
