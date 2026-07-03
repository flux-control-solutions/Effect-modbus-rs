import { Effect, Schema } from "effect";
import type { AsciiTransportOptions, RtuTransportOptions, TcpTransportOptions } from "modbus-rs";
import { ModbusInvalidArgumentError, type ModbusError } from "./errors";
import type { EffectModbusClient } from "./modbus-client";
/**
 * Schema for a single coil (digital output) definition.
 *
 * Each entry declares a coil's address and its default boolean state
 * used when the mock transport initialises.
 */
export declare const CoilDefinition: Schema.Struct<{
    address: typeof Schema.Number;
    default: typeof Schema.Boolean;
}>;
/**
 * Schema for a single discrete input (digital input) definition.
 *
 * Each entry declares a discrete input's address and its default
 * boolean state used when the mock transport initialises.
 */
export declare const DiscreteInputDefinition: Schema.Struct<{
    address: typeof Schema.Number;
    default: typeof Schema.Boolean;
}>;
/**
 * Schema for a single register (holding or input) definition.
 *
 * Each entry declares a register's address and its default 16-bit
 * value used when the mock transport initialises.
 */
export declare const RegisterDefinition: Schema.Struct<{
    address: typeof Schema.Number;
    default: typeof Schema.Number;
}>;
/**
 * Schema for a complete slave device definition.
 *
 * Describes a Modbus slave identified by `unitId`, with optional
 * arrays of coils, discrete inputs, holding registers, and input
 * registers. All arrays default to `[]` when omitted.
 */
export declare const SlaveDeviceDefinition: Schema.Struct<{
    unitId: typeof Schema.Number;
    coils: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Boolean;
    }>>, {
        default: () => never[];
    }>;
    discreteInputs: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Boolean;
    }>>, {
        default: () => never[];
    }>;
    holdingRegisters: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Number;
    }>>, {
        default: () => never[];
    }>;
    inputRegisters: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Number;
    }>>, {
        default: () => never[];
    }>;
}>;
/**
 * Schema for an array of {@link SlaveDeviceDefinition} — the complete
 * set of slave devices the mock transport should simulate.
 */
export declare const SlaveDeviceDefinitions: Schema.Array$<Schema.Struct<{
    unitId: typeof Schema.Number;
    coils: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Boolean;
    }>>, {
        default: () => never[];
    }>;
    discreteInputs: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Boolean;
    }>>, {
        default: () => never[];
    }>;
    holdingRegisters: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Number;
    }>>, {
        default: () => never[];
    }>;
    inputRegisters: Schema.optionalWith<Schema.Array$<Schema.Struct<{
        address: typeof Schema.Number;
        default: typeof Schema.Number;
    }>>, {
        default: () => never[];
    }>;
}>>;
/** Inferred TypeScript type for a {@link CoilDefinition} schema. */
export type CoilDefinition = Schema.Schema.Type<typeof CoilDefinition>;
/** Inferred TypeScript type for a {@link DiscreteInputDefinition} schema. */
export type DiscreteInputDefinition = Schema.Schema.Type<typeof DiscreteInputDefinition>;
/** Inferred TypeScript type for a {@link RegisterDefinition} schema. */
export type RegisterDefinition = Schema.Schema.Type<typeof RegisterDefinition>;
/** Inferred TypeScript type for a {@link SlaveDeviceDefinition} schema. */
export type SlaveDeviceDefinition = Schema.Schema.Type<typeof SlaveDeviceDefinition>;
/** Inferred TypeScript type for a {@link SlaveDeviceDefinitions} schema. */
export type SlaveDeviceDefinitions = Schema.Schema.Type<typeof SlaveDeviceDefinitions>;
/**
 * Creates a mock transport factory suitable for use as a `scoped`
 * {@link Layer} dependency in tests or development.
 *
 * Accepts an array of {@link SlaveDeviceDefinition} that describe the
 * simulated Modbus slaves, their register maps, and coil states.
 * The returned factory matches the signature expected by the transport
 * service constructors (`RtuTransportOptions | AsciiTransportOptions |
 * TcpTransportOptions`) so it can be injected into any service layer.
 *
 * Unsupported function codes (FIFO queue, file records) return
 * {@link ModbusInvalidArgumentError}.
 *
 * @param devices - Array of slave device definitions to simulate.
 * @returns A transport factory function that returns a scoped Effect
 *          providing the mock transport.
 */
export declare const makeMockTransport: (devices: SlaveDeviceDefinitions) => (_options: RtuTransportOptions | AsciiTransportOptions | TcpTransportOptions) => Effect.Effect<{
    withClient: (unitId: number) => Effect.Effect<EffectModbusClient, ModbusInvalidArgumentError, never>;
    setRequestTimeout: (_timeoutMs: number) => Effect.Effect<void, never, never>;
    clearRequestTimeout: () => Effect.Effect<void, never, never>;
    reconnect: () => Effect.Effect<void, ModbusError, never>;
    close: () => Effect.Effect<void, ModbusError, never>;
    hasPendingRequests: () => false;
}, never, never>;
