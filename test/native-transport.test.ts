import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Fiber, Predicate } from 'effect';

import { RtuTransportService } from '../src/RtuTransportService';
import { MAX_SERIAL_PORT_PATH } from '../src/serial-port-path';
import { TcpTransportService } from '../src/TcpTransportService';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const crc = (bytes: Uint8Array): Uint8Array => {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  }
  return new Uint8Array([value & 255, value >>> 8]);
};

let busNumber = 0;
const bus = async (latencyMs = 3) => {
  const path = join(tmpdir(), `mbus-check-${process.pid}-${++busNumber}`);
  const proc = Bun.spawn(['socat', `pty,raw,echo=0,link=${path}`, 'stdio'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: Array<number> = [];
  let pending = Buffer.alloc(0);
  const reader = proc.stdout.getReader();
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending = Buffer.concat([pending, chunk.value]);
      while (pending.length >= 8) {
        const frame = pending.subarray(0, 8);
        pending = pending.subarray(8);
        const unit = frame[0]!;
        requests.push(unit);
        if (unit === 2) continue;
        const pdu = new Uint8Array([unit, 3, 2, 0, unit]);
        const timer = setTimeout(() => {
          timers.delete(timer);
          proc.stdin.write(new Uint8Array([...pdu, ...crc(pdu)]));
          void proc.stdin.flush();
        }, latencyMs);
        timers.add(timer);
      }
    }
  })().catch(() => undefined);
  const stop = async () => {
    for (const timer of timers) clearTimeout(timer);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await proc.exited;
    rmSync(path, { force: true });
  };
  closers.push(stop);
  for (let i = 0; !existsSync(path); i++) {
    if (i > 200) throw new Error('The serial test port did not start');
    await Bun.sleep(5);
  }
  return { path, requests, stop };
};

const readOne = { address: 0, quantity: 1 };
const serialTest = test.skipIf(Bun.which('socat') === null);

serialTest(
  'a raw native abort drains its reply before a healthy unit read',
  async () => {
    const device = await bus(100);
    const { AsyncRtuTransport } = await import('modbus-rs');
    const transport = await AsyncRtuTransport.open({
      portPath: device.path,
      baudRate: 115200,
      responseTimeoutMs: 300,
    });
    closers.push(() => transport.close());
    transport.setRequestTimeout(300);
    const first = transport.createClient({ unitId: 1 });
    const next = transport.createClient({ unitId: 3 });
    expect([...(await first.readHoldingRegisters(readOne))]).toEqual([1]);

    const controller = new AbortController();
    const before = device.requests.length;
    const cancelled = first.readHoldingRegisters({ ...readOne, signal: controller.signal }).then(
      () => 'completed',
      (error: Error) => error.message,
    );
    // Synchronize the abort with wire transmission so the late reply is still pending.
    while (device.requests.length === before) await Bun.sleep(1);
    await Bun.sleep(20);
    controller.abort();
    expect(await cancelled).toContain('aborted');
    expect([...(await next.readHoldingRegisters(readOne))]).toEqual([3]);
  },
  5000,
);

serialTest(
  'a cleared native time limit cannot prevent interruption and scope close',
  async () => {
    const device = await bus();
    await Effect.gen(function* () {
      const api = yield* RtuTransportService.makeScoped({
        portPath: device.path,
        baudRate: 115200,
        responseTimeoutMs: 100,
      });
      const silent = yield* api.withClient(2);
      const healthy = yield* api.withClient(3);
      yield* api.setRequestTimeout(50);
      yield* api.clearRequestTimeout();
      const started = performance.now();
      const pending = yield* Effect.forkChild(silent.readHoldingRegisters(readOne));
      while (device.requests.length === 0) yield* Effect.sleep('1 millis');
      yield* Fiber.interrupt(pending);
      expect(performance.now() - started).toBeLessThan(1000);
      yield* api.reconnect();
      yield* api.setRequestTimeout(100);
      expect([...(yield* healthy.readHoldingRegisters(readOne))]).toEqual([3]);
    }).pipe(Effect.scoped, Effect.runPromise);
  },
  5000,
);

serialTest(
  'Effect interruption drains a serial reply before the next unit request',
  async () => {
    const device = await bus(100);
    await Effect.gen(function* () {
      const api = yield* RtuTransportService.makeScoped({
        portPath: device.path,
        baudRate: 115200,
        responseTimeoutMs: 300,
      });
      const first = yield* api.withClient(1);
      const next = yield* api.withClient(3);
      const pending = yield* Effect.forkChild(first.readHoldingRegisters(readOne));
      while (device.requests.length === 0) yield* Effect.sleep('1 millis');
      yield* Effect.sleep('20 millis');
      yield* Fiber.interrupt(pending);
      expect([...(yield* next.readHoldingRegisters(readOne))]).toEqual([3]);
    }).pipe(Effect.scoped, Effect.runPromise);
  },
  5000,
);

serialTest(
  'an interrupted queued call never reaches an unbounded serial transport',
  async () => {
    const device = await bus(100);
    await Effect.gen(function* () {
      const api = yield* RtuTransportService.makeScoped({
        portPath: device.path,
        baudRate: 115200,
        responseTimeoutMs: 300,
      });
      const first = yield* api.withClient(1);
      const next = yield* api.withClient(3);
      yield* api.clearRequestTimeout();
      const pending = yield* Effect.forkChild(first.readHoldingRegisters(readOne));
      while (device.requests.length === 0) yield* Effect.sleep('1 millis');
      const queued = yield* Effect.forkChild(next.readHoldingRegisters(readOne));
      yield* Effect.sleep('5 millis');
      yield* Fiber.interrupt(queued);
      expect([...(yield* Fiber.join(pending))]).toEqual([1]);
      expect(device.requests).toEqual([1]);
      expect([...(yield* next.readHoldingRegisters(readOne))]).toEqual([3]);
    }).pipe(Effect.scoped, Effect.runPromise);
  },
  5000,
);

serialTest(
  'a long stable link follows a replacement serial device on reconnect',
  async () => {
    const first = await bus();
    const second = await bus();
    const root = mkdtempSync(join(tmpdir(), 'mbus-stable-'));
    const path = join(root, 'x'.repeat(MAX_SERIAL_PORT_PATH + 10));
    symlinkSync(first.path, path);
    closers.push(async () => rmSync(root, { recursive: true, force: true }));
    await Effect.gen(function* () {
      const api = yield* RtuTransportService.makeScoped({
        portPath: path,
        baudRate: 115200,
        responseTimeoutMs: 250,
      });
      const client = yield* api.withClient(1);
      expect([...(yield* client.readHoldingRegisters(readOne))]).toEqual([1]);
      yield* Effect.promise(first.stop);
      unlinkSync(path);
      symlinkSync(second.path, path);
      yield* api.reconnect();
      expect([...(yield* client.readHoldingRegisters(readOne))]).toEqual([1]);
      expect(second.requests).toEqual([1]);
    }).pipe(Effect.scoped, Effect.runPromise);
  },
  5000,
);

test('TCP response timeouts keep the connection usable for other units', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (Predicate.isString(chunk)) throw new Error('The TCP test expects binary data');
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 7) {
        const size = 6 + pending.readUInt16BE(4);
        if (pending.length < size) break;
        const request = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (request[6] === 2) continue;
        const response = Buffer.from([
          request[0]!,
          request[1]!,
          0,
          0,
          0,
          5,
          request[6]!,
          3,
          2,
          0,
          request[6]!,
        ]);
        socket.write(response);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || Predicate.isString(address)) throw new Error('No TCP test address');
  await Effect.gen(function* () {
    const api = yield* TcpTransportService.makeScoped({
      host: '127.0.0.1',
      port: address.port,
      responseTimeoutMs: 100,
    });
    const silent = yield* api.withClient(2);
    const healthy = yield* api.withClient(3);
    const failure = yield* Effect.flip(silent.readHoldingRegisters(readOne));
    expect(failure._tag).toBe('ModbusTimeoutError');
    expect([...(yield* healthy.readHoldingRegisters(readOne))]).toEqual([3]);
  }).pipe(Effect.scoped, Effect.runPromise);
}, 5000);
