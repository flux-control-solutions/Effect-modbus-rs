import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

import { toModbusError } from '../src/errors';
import {
  MAX_SERIAL_PORT_PATH,
  resolveSerialPortPath,
  serialPortPathScoped,
} from '../src/serial-port-path';

const root = mkdtempSync(join(tmpdir(), 'serial-path-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Makes a path of the given length below `dir`. */
const longPath = (dir: string, length: number) => join(dir, 'x'.repeat(length - dir.length - 1));

test('a short path is used as it is', async () => {
  expect(await resolveSerialPortPath('/dev/ttyUSB0')).toBe('/dev/ttyUSB0');
});

test('a long link is replaced with its short target', async () => {
  const target = join(root, 'tty');
  writeFileSync(target, '');
  const link = longPath(root, MAX_SERIAL_PORT_PATH + 10);
  symlinkSync(target, link);
  expect(await resolveSerialPortPath(link)).toBe(target);
});

test('a long path without a short target fails with an invalid argument error', async () => {
  const dir = join(root, 'd'.repeat(MAX_SERIAL_PORT_PATH));
  mkdirSync(dir);
  const device = join(dir, 'tty');
  writeFileSync(device, '');
  const error = await resolveSerialPortPath(device).then(
    () => new Error('the path was accepted'),
    (cause: Error) => cause,
  );
  const mapped = toModbusError(error);
  expect(mapped._tag).toBe('ModbusInvalidArgumentError');
  expect(mapped.message).toContain(`at most ${MAX_SERIAL_PORT_PATH} characters`);
});

test('a scoped serial alias follows a stable link after its target changes', async () => {
  const first = join(root, 'first');
  const second = join(root, 'second');
  writeFileSync(first, '');
  writeFileSync(second, '');
  const link = longPath(root, MAX_SERIAL_PORT_PATH + 20);
  symlinkSync(first, link);
  let alias = '';
  await Effect.gen(function* () {
    const getPath = yield* serialPortPathScoped(link);
    alias = yield* Effect.promise(getPath);
    expect(alias.length).toBeLessThanOrEqual(MAX_SERIAL_PORT_PATH);
    expect(realpathSync(alias)).toBe(first);
    unlinkSync(link);
    symlinkSync(second, link);
    expect(yield* Effect.promise(getPath)).toBe(alias);
    expect(realpathSync(alias)).toBe(second);
  }).pipe(Effect.scoped, Effect.runPromise);
  expect(existsSync(alias)).toBe(false);
});
