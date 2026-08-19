import { Context, Layer } from 'effect';

import { makeMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import type { TransportResilienceOptions, TransportServiceApi } from './shared-transport';
import {
  WasmAsciiTransportService,
  type WasmAsciiTransportOpenOptions,
} from './WasmAsciiTransportService';
import {
  WasmRtuTransportService,
  type WasmRtuTransportOpenOptions,
} from './WasmRtuTransportService';

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
export class WasmSerialTransportService extends Context.Service<
  WasmSerialTransportService,
  TransportServiceApi
>()('WasmSerialTransportService') {
  /**
   * Creates a {@link Layer} providing {@link WasmSerialTransportService}
   * backed by an ASCII transport.
   */
  static fromAscii(
    options: WasmAsciiTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<WasmSerialTransportService> {
    return Layer.flatMap(WasmAsciiTransportService.make(options), (context) =>
      Layer.succeed(WasmSerialTransportService, Context.get(context, WasmAsciiTransportService)),
    );
  }

  /**
   * Creates a {@link Layer} providing {@link WasmSerialTransportService}
   * backed by an RTU transport.
   */
  static fromRtu(
    options: WasmRtuTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<WasmSerialTransportService> {
    return Layer.flatMap(WasmRtuTransportService.make(options), (context) =>
      Layer.succeed(WasmSerialTransportService, Context.get(context, WasmRtuTransportService)),
    );
  }

  /**
   * Creates a mock {@link Layer} that provides {@link WasmSerialTransportService}
   * for tests or development.
   *
   * The `devices` parameter is an array of {@link SlaveDeviceDefinition}. Each
   * definition gives the coil map and the register map of one simulated slave.
   *
   * The option set is the same as the option set of the concrete tags. Thus a
   * test that keeps the framing abstract can also set `retry`, `reconnect`,
   * `fault`, and `reconnectFault`.
   *
   * @param devices - The slave device definitions for the mock.
   * @returns A function that takes the mock options and gives a scoped
   *          {@link Layer} that provides the mock service.
   * @see MockFaultOptions — The `fault` hook and the `reconnectFault` hook.
   * @see makeMockTransport — The mock factory that this method uses.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (
      options: (WasmAsciiTransportOpenOptions | WasmRtuTransportOpenOptions) &
        TransportResilienceOptions &
        MockFaultOptions,
    ): Layer.Layer<WasmSerialTransportService> =>
      Layer.effect(WasmSerialTransportService, factory(options));
  };
}
