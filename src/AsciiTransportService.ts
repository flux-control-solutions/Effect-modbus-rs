/** Provides scoped ASCII Modbus transport layers and an in-memory mock layer. */
import { Context, Effect, Layer } from 'effect';
import type {
  AsyncAsciiTransport,
  AsyncSerialModbusClient,
  AsciiTransportOptions,
} from 'modbus-rs';

import { createMockTransport, type MockFaultOptions, type SlaveDeviceDefinitions } from './mocks';
import { serialPortPathScoped } from './serial-port-path';
import { createTransportScoped } from './shared-transport';
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
 * scope finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncAsciiTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncAsciiTransport — Upstream `modbus-rs` ASCII transport.
 * @see AsciiTransportOpenOptions — Configuration for the ASCII serial port.
 * @see createTransportScoped — Generic lifecycle logic from shared-transport.
 */
export class AsciiTransportService extends Context.Service<
  AsciiTransportService,
  TransportServiceApi
>()('AsciiTransportService') {
  /**
   * Scoped constructor effect for the service. v4 does not auto-generate a
   * layer from this, so {@link AsciiTransportService.make} builds one explicitly.
   */
  static readonly makeScoped = Effect.fnUntraced(function* (
    options: AsciiTransportOpenOptions & TransportResilienceOptions,
  ) {
    const portPath = yield* serialPortPathScoped(options.portPath);
    return yield* createTransportScoped<
      AsciiTransportOpenOptions,
      AsyncSerialModbusClient,
      AsyncAsciiTransport
    >(
      'AsyncAsciiTransport',
      async (transportConstructor, options: AsciiTransportOpenOptions) => {
        // SAFETY: The constructor is read from the AsyncAsciiTransport export named above.
        return (transportConstructor as typeof AsyncAsciiTransport).open({
          ...options,
          portPath: await portPath(),
          responseTimeoutMs: options.responseTimeoutMs ?? options.requestTimeoutMs,
        });
      },
      'AsciiTransportService',
      {
        serializeRequests: true,
        responseTimeoutMs: (options) => options.responseTimeoutMs ?? options.requestTimeoutMs,
      },
    )(options);
  });

  /**
   * Creates a {@link Layer} providing a live {@link AsciiTransportService}.
   *
   * @param options - Serial ASCII options and optional retry, reconnect, and connect-timeout settings.
   * @returns A layer whose scope opens the connection on first use and closes it on finalization.
   */
  static readonly make = (
    options: AsciiTransportOpenOptions & TransportResilienceOptions,
  ): Layer.Layer<AsciiTransportService> =>
    Layer.effect(AsciiTransportService, AsciiTransportService.makeScoped(options));
  /**
   * Creates a {@link Layer} providing an in-memory mock
   * {@link AsciiTransportService} for testing or development.
   *
   * Accepts an array of {@link SlaveDeviceDefinition} values describing the
   * simulated Modbus slaves and their register/coil maps.
   *
   * @param devices - Slave device definitions for the mock.
   * @returns A factory that accepts transport, resilience, and mock-fault options and returns a layer for the mock service.
   *
   * @see makeMockTransport — The underlying mock factory.
   */
  static makeMockTransport = (devices: SlaveDeviceDefinitions) => {
    const factory = createMockTransport(devices);
    return (options: AsciiTransportOpenOptions & TransportResilienceOptions & MockFaultOptions) =>
      Layer.effect(AsciiTransportService, factory(options));
  };
}
