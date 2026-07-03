import type { AsciiTransportOptions } from "modbus-rs";
import { Effect, Layer } from "effect";
import { SlaveDeviceDefinitions } from "./mocks";
declare const AsciiTransportService_base: Effect.Service.Class<AsciiTransportService, "AsciiTransportService", {
    readonly scoped: (options: AsciiTransportOptions) => Effect.Effect<{
        withClient: (unitId: number) => Effect.Effect<import("./modbus-client").EffectModbusClient, import("./errors").ModbusError, never>;
        setRequestTimeout: (timeoutMs: number) => Effect.Effect<undefined, import("./errors").ModbusNotConnectedError, never>;
        clearRequestTimeout: () => Effect.Effect<undefined, import("./errors").ModbusNotConnectedError, never>;
        reconnect: () => Effect.Effect<undefined, import("./errors").ModbusError, never>;
        close: () => Effect.Effect<void, import("./errors").ModbusError, import("effect/Scope").Scope>;
        hasPendingRequests: () => boolean;
    }, never, import("effect/Scope").Scope>;
}>;
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
 * @see AsciiTransportOptions — Configuration for the ASCII serial port.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export declare class AsciiTransportService extends AsciiTransportService_base {
    /**
     * Creates a {@link Layer} providing an in-memory mock
     * {@link AsciiTransportService} for testing or development.
     *
     * Accepts an array of {@link SlaveDeviceDefinition} describing the
     * simulated Modbus slaves and their register/coil maps.
     *
     * @param devices - Slave device definitions for the mock.
     * @returns A function that takes {@link AsciiTransportOptions} and
     *          returns a scoped {@link Layer} providing the mock service.
     *
     * @see makeMockTransport — The underlying mock factory.
     */
    static makeMockTransport: (devices: SlaveDeviceDefinitions) => (options: AsciiTransportOptions) => Layer.Layer<AsciiTransportService, never, never>;
}
export {};
