import { Context, Effect, Layer } from 'effect';
import type { AsciiTransportOptions, RtuTransportOptions } from 'modbus-rs';

import { AsciiTransportService } from './AsciiTransportService';
import { makeMockTransport, type SlaveDeviceDefinitions } from './mocks';
import { RtuTransportService } from './RtuTransportService';
import type { TransportServiceApi } from './shared-transport';

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
export class SerialTransportService extends Context.Tag('SerialTransportService')<
  SerialTransportService,
  TransportServiceApi
>() {
  /**
   * Creates a {@link Layer} providing {@link SerialTransportService}
   * backed by an ASCII transport.
   */
  static fromAscii(options: AsciiTransportOptions): Layer.Layer<SerialTransportService> {
    return Layer.project(
      AsciiTransportService,
      SerialTransportService,
      (ascii) => ascii,
    )(AsciiTransportService.Default(options));
  }

  /**
   * Creates a {@link Layer} providing {@link SerialTransportService}
   * backed by an RTU transport.
   */
  static fromRtu(options: RtuTransportOptions): Layer.Layer<SerialTransportService> {
    return Layer.project(
      RtuTransportService,
      SerialTransportService,
      (rtu) => rtu,
    )(RtuTransportService.Default(options));
  }

  /**
   * Creates a mock {@link Layer} providing {@link SerialTransportService}
   * for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (
      options: AsciiTransportOptions | RtuTransportOptions,
    ): Layer.Layer<SerialTransportService> =>
      Layer.scoped(SerialTransportService, factory(options) as Effect.Effect<TransportServiceApi>);
  };
}
