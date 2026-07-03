import type { RtuTransportOptions } from "modbus-rs";
import { Effect, Layer } from "effect";
import type { SlaveDeviceDefinitions } from "./mocks";
declare const RtuTransportService_base: Effect.Service.Class<RtuTransportService, "RtuTransportService", {
    readonly scoped: (options: RtuTransportOptions) => Effect.Effect<{
        withClient: (unitId: number) => Effect.Effect<import("./modbus-client").EffectModbusClient, import("./errors").ModbusError, never>;
        setRequestTimeout: (timeoutMs: number) => Effect.Effect<undefined, import("./errors").ModbusNotConnectedError, never>;
        clearRequestTimeout: () => Effect.Effect<undefined, import("./errors").ModbusNotConnectedError, never>;
        reconnect: () => Effect.Effect<undefined, import("./errors").ModbusError, never>;
        close: () => Effect.Effect<void, import("./errors").ModbusError, import("effect/Scope").Scope>;
        hasPendingRequests: () => boolean;
    }, never, import("effect/Scope").Scope>;
}>;
/**
 * Scoped Effect service wrapping the `modbus-rs` {@link AsyncRtuTransport}
 * for RTU (serial) Modbus communication.
 *
 * The transport connection is opened lazily on the first call to
 * `withClient(unitId)` and automatically closed when the consuming
 * {@link Effect.Scope | Scope} finalizes.
 *
 * Clients are created per `unitId` via
 * {@link AsyncRtuTransport.createClient} and cached, so repeated
 * requests for the same unit ID reuse the same client.
 *
 * @see AsyncRtuTransport — Upstream `modbus-rs` RTU transport.
 * @see RtuTransportOptions — Configuration for the RTU serial port.
 * @see makeTransportScoped — Generic lifecycle logic from shared-transport.
 */
export declare class RtuTransportService extends RtuTransportService_base {
    /**
     * Creates a {@link Layer} providing an in-memory mock
     * {@link RtuTransportService} for testing or development.
     *
     * Accepts an array of {@link SlaveDeviceDefinition} describing the
     * simulated Modbus slaves and their register/coil maps.
     *
     * @param devices - Slave device definitions for the mock.
     * @returns A function that takes {@link RtuTransportOptions} and
     *          returns a scoped {@link Layer} providing the mock service.
     *
     * @see makeMockTransport — The underlying mock factory.
     */
    static makeMockTransport: (devices: SlaveDeviceDefinitions) => (options: RtuTransportOptions) => Layer.Layer<RtuTransportService, never, never>;
}
export {};
