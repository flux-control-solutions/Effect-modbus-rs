import { Context, Layer } from "effect";
import type { AsciiTransportOptions, RtuTransportOptions } from "modbus-rs";
import type { TransportServiceApi } from "./shared-transport";
import { type SlaveDeviceDefinitions } from "./mocks";
declare const SerialTransportService_base: Context.TagClass<SerialTransportService, "SerialTransportService", TransportServiceApi>;
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
export declare class SerialTransportService extends SerialTransportService_base {
    /**
     * Creates a {@link Layer} providing {@link SerialTransportService}
     * backed by an ASCII transport.
     */
    static fromAscii(options: AsciiTransportOptions): Layer.Layer<SerialTransportService>;
    /**
     * Creates a {@link Layer} providing {@link SerialTransportService}
     * backed by an RTU transport.
     */
    static fromRtu(options: RtuTransportOptions): Layer.Layer<SerialTransportService>;
    /**
     * Creates a mock {@link Layer} providing {@link SerialTransportService}
     * for testing or development.
     *
     * Accepts an array of {@link SlaveDeviceDefinition} describing the
     * simulated Modbus slaves and their register/coil maps.
     */
    static makeMockTransport: (devices: SlaveDeviceDefinitions) => (options: AsciiTransportOptions | RtuTransportOptions) => Layer.Layer<SerialTransportService>;
}
export {};
