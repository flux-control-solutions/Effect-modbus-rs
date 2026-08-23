import { Context, Effect, Layer } from 'effect';
import type {
  AsyncAsciiTransport,
  AsyncSerialModbusClient,
  AsciiTransportOptions,
} from 'modbus-rs';

import { SlaveDeviceDefinitions, makeMockTransport } from './mocks';
import type { MockFaultOptions } from './mocks';
import { makeTransportScoped } from './shared-transport';
import type {
  TransportResilienceOptions,
  WithoutUpstreamRetry,
  TransportServiceApi,
} from './shared-transport';

/**
 * {@link AsciiTransportOptions} minus the upstream retry knobs.
 *
 * @see WithoutUpstreamRetry — Why they are withheld.
 */
export type AsciiTransportOpenOptions = WithoutUpstreamRetry<AsciiTransportOptions>;

/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncAsciiTransport}
 * for ASCII (serial) Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncAsciiTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncAsciiTransport — Upstream `modbus-rs` ASCII transport.
 * @see AsciiTransportOpenOptions — Configuration for the ASCII serial port.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class AsciiTransportService extends Context.Service<
  AsciiTransportService,
  TransportServiceApi
>()('AsciiTransportService') {
  /**
   * Scoped constructor effect for the service. v4 does not auto-generate a
   * layer from this, so {@link AsciiTransportService.make} builds one explicitly.
   */
  static readonly makeScoped = makeTransportScoped<
    AsciiTransportOpenOptions,
    AsyncSerialModbusClient,
    AsyncAsciiTransport
  >(
    'AsyncAsciiTransport',
    (TC: unknown, options: AsciiTransportOpenOptions) =>
      (TC as typeof AsyncAsciiTransport).open(options),
    'AsciiTransportService',
  );

  /**
   * Creates a {@link Layer} providing a live {@link AsciiTransportService}.
   *
   * @param options - Connection and resilience options for the transport.
   */
  static readonly make = (
    options: AsciiTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<AsciiTransportService> =>
    Layer.effect(AsciiTransportService, AsciiTransportService.makeScoped(options));
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link AsciiTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A function that takes {@link AsciiTransportOpenOptions} and
   *          returns a scoped {@link Layer} providing the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = makeMockTransport(devices);
    return (options: AsciiTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(
        AsciiTransportService,
        factory(options) as unknown as Effect.Effect<TransportServiceApi>,
      );
  };
}
