/**
 * Wires up a small vanilla-DOM UI (see ../index.html) to effect-modbus-rs's
 * browser transport services, so this can be run in a real browser for manual
 * testing or as a starting point for a consumer's own app.
 *
 * The connection is kept open across multiple button clicks (connect once,
 * read many times, disconnect explicitly) by manually managing an Effect
 * `Scope` instead of using `Effect.scoped` — see `connectWs`/`connectSerial`.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  WasmAsciiTransportService,
  WasmRtuTransportService,
  WasmWsTransportService,
  requestSerialPort,
  type EffectModbusClient,
} from "effect-modbus-rs";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const modeEl = $<HTMLSelectElement>("mode");
const wsFieldsEl = $<HTMLDivElement>("ws-fields");
const serialFieldsEl = $<HTMLDivElement>("serial-fields");
const serialBaudRowEl = $<HTMLDivElement>("serial-baud-row");
const wsUrlEl = $<HTMLInputElement>("wsUrl");
const protocolEl = $<HTMLSelectElement>("protocol");
const baudRateEl = $<HTMLSelectElement>("baudRate");
const unitIdEl = $<HTMLInputElement>("unitId");
const connectBtn = $<HTMLButtonElement>("connect");
const disconnectBtn = $<HTMLButtonElement>("disconnect");
const readBtn = $<HTMLButtonElement>("read");
const addressEl = $<HTMLInputElement>("address");
const quantityEl = $<HTMLInputElement>("quantity");
const statusEl = $<HTMLSpanElement>("status");
const logEl = $<HTMLDivElement>("log");

const log = (msg: string) => {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${msg}\n${logEl.textContent}`;
};

const setStatus = (status: string) => {
  statusEl.textContent = status;
  const connected = status === "connected";
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  readBtn.disabled = !connected;
};

modeEl.addEventListener("change", () => {
  const isWs = modeEl.value === "ws";
  wsFieldsEl.style.display = isWs ? "" : "none";
  serialFieldsEl.style.display = isWs ? "none" : "";
  serialBaudRowEl.style.display = isWs ? "none" : "";
});

let scope: Scope.CloseableScope | null = null;
let client: EffectModbusClient | null = null;

const connectWs = async (unitId: number) => {
  scope = Effect.runSync(Scope.make());
  const layer = WasmWsTransportService.Default({
    wsUrl: wsUrlEl.value,
    requestTimeoutMs: 3000,
  });
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const transport = Context.get(context, WasmWsTransportService);
  client = await Effect.runPromise(transport.withClient(unitId));
};

const connectSerial = async (unitId: number) => {
  // Must run inside this click handler — Web Serial's requestPort() requires a
  // user gesture. `connect()` below is itself the click handler.
  const port = await Effect.runPromise(requestSerialPort());
  const baudRate = Number(baudRateEl.value);

  scope = Effect.runSync(Scope.make());
  if (protocolEl.value === "rtu") {
    const layer = WasmRtuTransportService.Default({ port, baudRate });
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const transport = Context.get(context, WasmRtuTransportService);
    client = await Effect.runPromise(transport.withClient(unitId));
  } else {
    const layer = WasmAsciiTransportService.Default({ port, baudRate });
    const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
    const transport = Context.get(context, WasmAsciiTransportService);
    client = await Effect.runPromise(transport.withClient(unitId));
  }
};

connectBtn.addEventListener("click", async () => {
  setStatus("connecting");
  const unitId = Number(unitIdEl.value);
  try {
    if (modeEl.value === "ws") {
      await connectWs(unitId);
      log(`Connected via WebSocket gateway at ${wsUrlEl.value}`);
    } else {
      await connectSerial(unitId);
      log(`Connected via Web Serial (${protocolEl.value.toUpperCase()})`);
    }
    setStatus("connected");
  } catch (error) {
    log(`Connect failed: ${error}`);
    setStatus("error");
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = null;
    }
  }
});

disconnectBtn.addEventListener("click", async () => {
  if (scope) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
  }
  client = null;
  log("Disconnected");
  setStatus("disconnected");
});

readBtn.addEventListener("click", async () => {
  if (!client) return;
  const address = Number(addressEl.value);
  const quantity = Number(quantityEl.value);
  try {
    const result = await Effect.runPromise(client.readHoldingRegisters({ address, quantity }));
    log(`Read [${address}..${address + quantity - 1}]: ${Array.from(result).join(", ")}`);
  } catch (error) {
    log(`Read failed: ${error}`);
  }
});

log("Ready. Choose a mode and click Connect.");
