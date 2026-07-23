import { Effect } from "effect";
import type { WasmSerialPortHandle } from "modbus-rs/web";
import type { ModbusError } from "./errors";
import { toModbusError } from "./errors";

/**
 * Requests a browser serial port handle via the Web Serial API, for use with
 * {@link WasmSerialTransportService.fromRtu} / `.fromAscii` (or
 * `WasmRtuTransportService.Default` / `WasmAsciiTransportService.Default` directly).
 *
 * **Must be called synchronously from within a user-gesture event handler**
 * (e.g. a `click` listener) — this is a hard Web Serial API / browser security
 * constraint (`navigator.serial.requestPort()` semantics), not a library-imposed
 * restriction. Calling it outside a gesture will reject.
 *
 * @example
 * ```ts
 * button.addEventListener("click", () => {
 *   Effect.runPromise(
 *     requestSerialPort().pipe(
 *       Effect.flatMap((port) => Effect.provide(program, WasmRtuTransportService.Default({ port, baudRate: 19200 }))),
 *     ),
 *   );
 * });
 * ```
 *
 * @see WasmSerialPortHandle — Opaque handle returned by `modbus-rs`'s WASM bindings.
 */
export const requestSerialPort = (): Effect.Effect<WasmSerialPortHandle, ModbusError> =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import("modbus-rs/web");
      return mod.requestSerialPort();
    },
    catch: (error) => toModbusError(error as Error),
  });
