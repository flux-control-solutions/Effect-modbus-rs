import {
  WasmAsciiTransportService,
  WasmRtuTransportService,
  WasmWsTransportService,
  requestSerialPort,
  type EffectModbusClient,
} from '@flux-control/effect-modbus-rs';
/**
 * Wires up a small vanilla-DOM UI (see ../index.html) to effect-modbus-rs's
 * browser transport services, so this can be run in a real browser for manual
 * testing or as a starting point for a consumer's own app.
 *
 * The connection is kept open across multiple button clicks (connect once,
 * read many times, disconnect explicitly) by manually managing an Effect
 * `Scope` instead of using `Effect.scoped` — see `connectWs`/`connectSerial`.
 */
import { Context, Effect, Exit, Layer, Scope } from 'effect';

/** Returns the required DOM element after checking its concrete runtime type. */
const $ = <T extends HTMLElement>(id: string, constructor: { new (): T }): T => {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id} to be a ${constructor.name}`);
  }
  return element;
};

const modeEl = $('mode', HTMLSelectElement);
const wsFieldsEl = $('ws-fields', HTMLDivElement);
const serialFieldsEl = $('serial-fields', HTMLDivElement);
const serialBaudRowEl = $('serial-baud-row', HTMLDivElement);
const wsUrlEl = $('wsUrl', HTMLInputElement);
const protocolEl = $('protocol', HTMLSelectElement);
const baudRateEl = $('baudRate', HTMLSelectElement);
const unitIdEl = $('unitId', HTMLInputElement);
const connectBtn = $('connect', HTMLButtonElement);
const disconnectBtn = $('disconnect', HTMLButtonElement);
const readBtn = $('read', HTMLButtonElement);
const addressEl = $('address', HTMLInputElement);
const quantityEl = $('quantity', HTMLInputElement);
const statusEl = $('status', HTMLSpanElement);
const logEl = $('log', HTMLDivElement);

/** Prepends a timestamped status message to the on-page connection log. */
const log = (msg: string) => {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${msg}\n${logEl.textContent}`;
};

/** Updates the visible connection state and enables only valid actions. */
const setStatus = (status: string) => {
  statusEl.textContent = status;
  const connected = status === 'connected';
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  readBtn.disabled = !connected;
};

modeEl.addEventListener('change', () => {
  const isWs = modeEl.value === 'ws';
  wsFieldsEl.style.display = isWs ? '' : 'none';
  serialFieldsEl.style.display = isWs ? 'none' : '';
  serialBaudRowEl.style.display = isWs ? 'none' : '';
});

let scope: Scope.Closeable | null = null;
let client: EffectModbusClient | null = null;

/**
 * Builds a WebSocket transport in a manually managed scope and obtains its
 * client. The caller closes that scope on Disconnect or failed connection.
 */
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

/**
 * Requests a Web Serial port while the click gesture is active, then builds
 * the selected RTU or ASCII transport in a manually managed scope.
 */
const connectSerial = async (unitId: number) => {
  // Must run inside this click handler — Web Serial's requestPort() requires a
  // user gesture. `connect()` below is itself the click handler.
  const port = await Effect.runPromise(requestSerialPort());
  const baudRate = Number(baudRateEl.value);

  scope = Effect.runSync(Scope.make());
  if (protocolEl.value === 'rtu') {
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

connectBtn.addEventListener('click', async () => {
  setStatus('connecting');
  const unitId = Number(unitIdEl.value);
  try {
    if (modeEl.value === 'ws') {
      await connectWs(unitId);
      log(`Connected via WebSocket gateway at ${wsUrlEl.value}`);
    } else {
      await connectSerial(unitId);
      log(`Connected via Web Serial (${protocolEl.value.toUpperCase()})`);
    }
    setStatus('connected');
  } catch (error) {
    log(`Connect failed: ${error}`);
    setStatus('error');
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      scope = null;
    }
  }
});

disconnectBtn.addEventListener('click', async () => {
  if (scope) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
  }
  client = null;
  log('Disconnected');
  setStatus('disconnected');
});

readBtn.addEventListener('click', async () => {
  if (!client) return;
  const address = Number(addressEl.value);
  const quantity = Number(quantityEl.value);
  try {
    const result = await Effect.runPromise(client.readHoldingRegisters({ address, quantity }));
    log(`Read [${address}..${address + quantity - 1}]: ${Array.from(result).join(', ')}`);
  } catch (error) {
    log(`Read failed: ${error}`);
  }
});

log('Ready. Choose a mode and click Connect.');
