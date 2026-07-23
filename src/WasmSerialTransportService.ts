import { Context, Effect, Layer } from "effect";
import { WasmAsciiTransportService, type WasmAsciiTransportOpenOptions } from "./WasmAsciiTransportService";
import { WasmRtuTransportService, type WasmRtuTransportOpenOptions } from "./WasmRtuTransportService";
import type { TransportServiceApi } from "./shared-transport";
import { makeMockTransport, type SlaveDeviceDefinitions } from "./mocks";

/**
 * Abstract browser (WASM) serial Modbus transport service tag.
 *
 * Represents a Web Serial-based Modbus transport backed by either ASCII or RTU
 * framing. Use this tag when you need a browser serial transport but don't care
 * about the specific framing protocol.
 *
 * Consumers `yield* WasmSerialTransportService` to obtain a
 * {@link TransportServiceApi} and satisfy the tag via one of the static
 * provider methods:
 *
 * ```ts
 * // Provide with ASCII framing
 * Layer.provide(WasmSerialTransportService.fromAscii({ port, baudRate: 9600 }))
 *
 * // Provide with RTU framing
 * Layer.provide(WasmSerialTransportService.fromRtu({ port, baudRate: 9600 }))
 * ```
 *
 * @see requestSerialPort — Obtains the `port` handle both providers need (must be called from a user gesture).
 */
export class WasmSerialTransportService extends Context.Tag(
  "WasmSerialTransportService",
)<WasmSerialTransportService, TransportServiceApi>() {
  /**
   * Creates a {@link Layer} providing {@link WasmSerialTransportService}
   * backed by an ASCII transport.
   */
  static fromAscii(
    options: WasmAsciiTransportOpenOptions,
  ): Layer.Layer<WasmSerialTransportService> {
    return Layer.project(
      WasmAsciiTransportService,
      WasmSerialTransportService,
      (ascii) => ascii,
    )(WasmAsciiTransportService.Default(options));
  }

  /**
   * Creates a {@link Layer} providing {@link WasmSerialTransportService}
   * backed by an RTU transport.
   */
  static fromRtu(
    options: WasmRtuTransportOpenOptions,
  ): Layer.Layer<WasmSerialTransportService> {
    return Layer.project(
      WasmRtuTransportService,
      WasmSerialTransportService,
      (rtu) => rtu,
    )(WasmRtuTransportService.Default(options));
  }

  /**
   * Creates a mock {@link Layer} providing {@link WasmSerialTransportService}
   * for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (
      options: WasmAsciiTransportOpenOptions | WasmRtuTransportOpenOptions,
    ): Layer.Layer<WasmSerialTransportService> =>
      Layer.scoped(
        WasmSerialTransportService,
        factory(options) as Effect.Effect<TransportServiceApi>,
      );
  };
}
