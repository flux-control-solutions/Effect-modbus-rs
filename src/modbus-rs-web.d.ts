/**
 * TEMPORARY ambient type shim for `modbus-rs/web`.
 *
 * `modbus-rs`'s WASM build (published separately as `modbus-rs-wasm`, re-exported
 * under the `modbus-rs/web` subpath) is currently broken on npm: the published
 * `modbus-rs-wasm@0.15.4` tarball contains only `LICENSE`/`package.json`/`README.md` —
 * no `.wasm` binary and no generated `.d.ts`. There is nowhere to import real types
 * from today, so this file hand-declares the surface this package uses, derived
 * directly from the upstream Rust source (`mbus-ffi/src/wasm/**`, `references/modbus-rs`
 * @ commit d95002a) rather than from a generated `.d.ts`.
 *
 * DELETE THIS FILE once upstream republishes a working `modbus-rs-wasm` build whose
 * real `.d.ts` resolves through `modbus-rs`'s `./web` export — at that point these
 * declarations become redundant (and should be checked against the real ones).
 *
 * Two response shapes below (`readFifoQueue`, `readDeviceIdentification`) are marked
 * best-effort: the upstream JSDoc-declared return type and the actual Rust
 * `WasmResponse::to_js_value` serialization disagree in `mbus-ffi/src/wasm/client/response.rs`
 * (a latent upstream inconsistency, not something we can resolve without a working build
 * to test against). This file follows the hand-written JSDoc `@returns` annotations,
 * since those are what `wasm_bindgen(skip_typescript)` actually emits as the real `.d.ts`
 * contract; `src/modbus-client.ts` normalizes the small remaining gaps.
 */
import type { CoilState, ServerHandlers } from "modbus-rs";

declare module "modbus-rs/web" {
  // ── Shared option/response shapes (mirrors mbus-ffi/src/wasm/wasm_types.rs) ──

  export interface CreateClientOptions {
    unitId: number;
  }

  export interface ReadBitsOptions {
    address: number;
    quantity: number;
    signal?: AbortSignal;
  }

  export interface ReadRegistersOptions {
    address: number;
    quantity: number;
    signal?: AbortSignal;
  }

  export interface WriteSingleCoilOptions {
    address: number;
    value: CoilState;
    signal?: AbortSignal;
  }

  export interface WriteSingleRegisterOptions {
    address: number;
    value: number;
    signal?: AbortSignal;
  }

  export interface WriteMultipleCoilsOptions {
    address: number;
    values: CoilState[];
    signal?: AbortSignal;
  }

  export interface WriteMultipleRegistersOptions {
    address: number;
    values: Uint16Array;
    signal?: AbortSignal;
  }

  export interface MaskWriteRegisterOptions {
    address: number;
    andMask: number;
    orMask: number;
    signal?: AbortSignal;
  }

  export interface ReadWriteMultipleRegistersOptions {
    readAddress: number;
    readQuantity: number;
    writeAddress: number;
    writeValues: Uint16Array;
    signal?: AbortSignal;
  }

  export interface ReadFifoQueueOptions {
    address: number;
    signal?: AbortSignal;
  }

  export interface FileRecordReadRequest {
    fileNumber: number;
    recordNumber: number;
    recordLength: number;
  }

  export interface ReadFileRecordOptions {
    requests: FileRecordReadRequest[];
    signal?: AbortSignal;
  }

  export interface FileRecordWriteRequest {
    fileNumber: number;
    recordNumber: number;
    recordData: Uint16Array;
  }

  export interface WriteFileRecordOptions {
    requests: FileRecordWriteRequest[];
    signal?: AbortSignal;
  }

  export interface ReadDeviceIdentificationOptions {
    readDeviceIdCode?: number;
    objectId?: number;
    signal?: AbortSignal;
  }

  export interface DiagnosticsOptions {
    subFunction: number;
    data?: Uint16Array;
    signal?: AbortSignal;
  }

  export interface DiagnosticsResponse {
    subFunction: number;
    data: Uint16Array;
  }

  export interface DeviceIdentificationObject {
    id: number;
    value: string;
  }

  /**
   * Best-effort: JSDoc in `client_tcp.rs`/`client_serial.rs` only loosely describes this
   * as `Promise<object>`; the actual fields observed in `response.rs`'s
   * `WasmResponse::DeviceIdentification` serialization omit `nextObjectId` (present in
   * native's response shape) and add `readDeviceIdCode`. Declared as partial/optional
   * here; `makeWasmEffectModbusClient` fills in defaults for the unified public shape.
   */
  export interface WasmDeviceIdentificationResponse {
    readDeviceIdCode?: number;
    conformityLevel: number;
    moreFollows: boolean;
    objects: DeviceIdentificationObject[];
  }

  // ── Client: WebSocket-based TCP transport (Rust `WasmTcpTransport`, js_name `WasmWsTransport`) ──

  export interface WasmWsTransportOptions {
    wsUrl: string;
    requestTimeoutMs?: number;
  }

  export class WasmWsModbusClient {
    readonly pendingRequests: boolean;
    isConnected(): boolean;
    readCoils(options: ReadBitsOptions): Promise<boolean[]>;
    readDiscreteInputs(options: ReadBitsOptions): Promise<boolean[]>;
    readHoldingRegisters(options: ReadRegistersOptions): Promise<Uint16Array>;
    readInputRegisters(options: ReadRegistersOptions): Promise<Uint16Array>;
    writeSingleCoil(options: WriteSingleCoilOptions): Promise<void>;
    writeSingleRegister(options: WriteSingleRegisterOptions): Promise<void>;
    writeMultipleCoils(options: WriteMultipleCoilsOptions): Promise<void>;
    writeMultipleRegisters(options: WriteMultipleRegistersOptions): Promise<void>;
    readWriteMultipleRegisters(options: ReadWriteMultipleRegistersOptions): Promise<Uint16Array>;
    maskWriteRegister(options: MaskWriteRegisterOptions): Promise<void>;
    /** Best-effort return shape — see module-level doc comment. */
    readFifoQueue(options: ReadFifoQueueOptions): Promise<Uint16Array>;
    readFileRecord(options: ReadFileRecordOptions): Promise<Uint16Array[]>;
    writeFileRecord(options: WriteFileRecordOptions): Promise<void>;
    readExceptionStatus(): Promise<number>;
    diagnostics(options: DiagnosticsOptions): Promise<DiagnosticsResponse>;
    /** Best-effort return shape — see module-level doc comment. */
    readDeviceIdentification(options: ReadDeviceIdentificationOptions): Promise<WasmDeviceIdentificationResponse>;
  }

  export class WasmWsTransport {
    static connect(options: WasmWsTransportOptions): Promise<WasmWsTransport>;
    reconnect(): Promise<void>;
    close(): Promise<void>;
    setRequestTimeout(ms: number): void;
    clearRequestTimeout(): void;
    readonly pendingRequests: boolean;
    createClient(options: CreateClientOptions): WasmWsModbusClient;
  }

  // ── Client: Web Serial transport (Rust `WasmRtuTransport`/`WasmAsciiTransport`) ──

  export interface WasmSerialTransportOptions {
    baudRate?: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
    requestTimeoutMs?: number;
  }

  export class WasmSerialPortHandle {
    isValid(): boolean;
  }

  export function requestSerialPort(): Promise<WasmSerialPortHandle>;

  export class WasmSerialModbusClient {
    readonly pendingRequests: boolean;
    isConnected(): boolean;
    readCoils(options: ReadBitsOptions): Promise<boolean[]>;
    readDiscreteInputs(options: ReadBitsOptions): Promise<boolean[]>;
    readHoldingRegisters(options: ReadRegistersOptions): Promise<Uint16Array>;
    readInputRegisters(options: ReadRegistersOptions): Promise<Uint16Array>;
    writeSingleCoil(options: WriteSingleCoilOptions): Promise<void>;
    writeSingleRegister(options: WriteSingleRegisterOptions): Promise<void>;
    writeMultipleCoils(options: WriteMultipleCoilsOptions): Promise<void>;
    writeMultipleRegisters(options: WriteMultipleRegistersOptions): Promise<void>;
    readWriteMultipleRegisters(options: ReadWriteMultipleRegistersOptions): Promise<Uint16Array>;
    maskWriteRegister(options: MaskWriteRegisterOptions): Promise<void>;
    /** Best-effort return shape — see module-level doc comment. */
    readFifoQueue(options: ReadFifoQueueOptions): Promise<Uint16Array>;
    readFileRecord(options: ReadFileRecordOptions): Promise<Uint16Array[]>;
    writeFileRecord(options: WriteFileRecordOptions): Promise<void>;
    readExceptionStatus(): Promise<number>;
    diagnostics(options: DiagnosticsOptions): Promise<DiagnosticsResponse>;
    /** Best-effort return shape — see module-level doc comment. */
    readDeviceIdentification(options: ReadDeviceIdentificationOptions): Promise<WasmDeviceIdentificationResponse>;
  }

  export class WasmRtuTransport {
    static open(port: WasmSerialPortHandle, options?: WasmSerialTransportOptions): Promise<WasmRtuTransport>;
    reconnect(): Promise<void>;
    close(): Promise<void>;
    setRequestTimeout(ms: number): void;
    clearRequestTimeout(): void;
    readonly pendingRequests: boolean;
    createClient(options: CreateClientOptions): WasmSerialModbusClient;
  }

  export class WasmAsciiTransport {
    static open(port: WasmSerialPortHandle, options?: WasmSerialTransportOptions): Promise<WasmAsciiTransport>;
    reconnect(): Promise<void>;
    close(): Promise<void>;
    setRequestTimeout(ms: number): void;
    clearRequestTimeout(): void;
    readonly pendingRequests: boolean;
    createClient(options: CreateClientOptions): WasmSerialModbusClient;
  }

  // ── Server: browser-facing servers (mbus-ffi/src/wasm/server/**) ──

  /**
   * Minimal ambient placeholder matching the one `modbus-rs` itself declares inline in
   * `mbus-ffi/src/wasm/server/server_serial.rs` (`interface SerialPort {}`), so consumers'
   * real DOM `SerialPort` (from their own app's `dom` lib) satisfies this structurally
   * without this package needing the `dom` lib itself.
   */
  export interface SerialPort {
    readonly [key: string]: unknown;
  }

  export interface WasmTcpServerOptions {
    wsUrl: string;
    unitId: number;
  }

  export class WasmWsModbusServer {
    static bind(options: WasmTcpServerOptions, handlers: ServerHandlers): Promise<WasmWsModbusServer>;
    serve(): Promise<void>;
    shutdown(): Promise<void>;
  }

  export interface WasmSerialServerOptions {
    serialPort: SerialPort;
    unitId: number;
    baudRate?: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
  }

  export class WasmSerialModbusServer {
    static bindRtu(options: WasmSerialServerOptions, handlers: ServerHandlers): Promise<WasmSerialModbusServer>;
    static bindAscii(options: WasmSerialServerOptions, handlers: ServerHandlers): Promise<WasmSerialModbusServer>;
    serve(): Promise<void>;
    shutdown(): Promise<void>;
  }
}
