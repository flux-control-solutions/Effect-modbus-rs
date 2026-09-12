import { Context, Layer } from 'effect';

import { AsciiTransportService, type AsciiTransportOpenOptions } from './AsciiTransportService';
import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { RtuTransportService, type RtuTransportOpenOptions } from './RtuTransportService';
import type { TransportResilienceOptions, TransportServiceApi } from './shared-transport';

/**
 * Abstract serial Modbus transport service tag.
 *
 * Represents a serial (RS-232/485) Modbus transport backed by either
 * ASCII or RTU framing.  Use this tag when you need a serial transport
 * but don't care about the specific framing protocol.
 *
 * Consumers `yield* SerialTransportService` to obtain a
 * {@link TransportServiceApi} and satisfy the tag via one of the static
 * provider methods:
 *
 * ```ts
 * // Provide with ASCII framing
 * Layer.provide(SerialTransportService.fromAscii({ path: "/dev/ttyUSB0", baudRate: 9600 }))
 *
 * // Provide with RTU framing
 * Layer.provide(SerialTransportService.fromRtu({ path: "/dev/ttyUSB0", baudRate: 9600 }))
 * ```
 */
export class SerialTransportService extends Context.Service<
  SerialTransportService,
  TransportServiceApi
>()('SerialTransportService') {
  /**
   * Creates a {@link Layer} providing {@link SerialTransportService}
   * backed by an ASCII transport.
   */
  static fromAscii(
    options: AsciiTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<SerialTransportService> {
    return Layer.flatMap(AsciiTransportService.make(options), (context) =>
      Layer.succeed(SerialTransportService, Context.get(context, AsciiTransportService)),
    );
  }

  /**
   * Creates a {@link Layer} providing {@link SerialTransportService}
   * backed by an RTU transport.
   */
  static fromRtu(
    options: RtuTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<SerialTransportService> {
    return Layer.flatMap(RtuTransportService.make(options), (context) =>
      Layer.succeed(SerialTransportService, Context.get(context, RtuTransportService)),
    );
  }

  /**
   * Creates a mock {@link Layer} that provides {@link SerialTransportService}
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
    const factory = createMockTransport(devices);
    return (
      options: (AsciiTransportOpenOptions | RtuTransportOpenOptions) &
        TransportResilienceOptions &
        MockFaultOptions,
    ): Layer.Layer<SerialTransportService> =>
      Layer.effect(SerialTransportService, factory(options));
  };
}
