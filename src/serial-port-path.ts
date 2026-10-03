import { Effect } from 'effect';

/** Maximum serial path length in the native 0.16.2 binding. */
export const MAX_SERIAL_PORT_PATH = 128;

/**
 * Gives a serial port path that `modbus-rs` accepts.
 *
 * Stable device links, such as `/dev/serial/by-id/...`, can be longer than
 * {@link MAX_SERIAL_PORT_PATH}. Such a link points to a short device path,
 * so a long path is replaced with its target. This function resolves one
 * snapshot. Transport services keep a short alias to the configured path for reconnects.
 *
 * @param portPath - The configured serial port path.
 * @returns The configured path, or the target of a long path.
 * @throws An error with the `MODBUS_INVALID_ARGUMENT` code when the path and
 *   its target are both too long.
 */
export const resolveSerialPortPath = async (portPath: string): Promise<string> => {
  if (portPath.length <= MAX_SERIAL_PORT_PATH) return portPath;
  // Imported here, so that a browser bundle does not load `node:fs`.
  const { realpath } = await import('node:fs/promises');
  const target = await realpath(portPath).catch(() => portPath);
  if (target.length <= MAX_SERIAL_PORT_PATH) return target;
  throw new Error(
    `[MODBUS_INVALID_ARGUMENT] Serial port path is ${portPath.length} characters long. ` +
      `modbus-rs accepts at most ${MAX_SERIAL_PORT_PATH} characters. ` +
      `Use a shorter path or a shorter link to the device: ${portPath}`,
  );
};

/** Keeps a short alias in the transport scope. Its target remains the configured stable link. */
export const serialPortPathScoped = Effect.fnUntraced(function* (portPath: string) {
  let directory: string | undefined;
  let alias: string | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (directory === undefined) return;
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: true });
    }),
  );
  return async (): Promise<string> => {
    if (portPath.length <= MAX_SERIAL_PORT_PATH) return portPath;
    if (alias !== undefined) return alias;
    await resolveSerialPortPath(portPath);
    const { mkdtemp, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    directory = await mkdtemp(join(tmpdir(), 'modbus-port-'));
    const path = join(directory, 'port');
    if (path.length > MAX_SERIAL_PORT_PATH)
      throw new Error(
        '[MODBUS_INVALID_ARGUMENT] The temporary serial alias path exceeds the native limit',
      );
    await symlink(resolve(portPath), path);
    alias = path;
    return alias;
  };
});
