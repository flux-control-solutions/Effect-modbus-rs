/**
 * The longest serial port path that `modbus-rs` 0.16.1 accepts.
 *
 * A longer path fails with `Port path too long (max 64 chars)`, and the
 * binding does not give that error a code.
 */
export const MAX_SERIAL_PORT_PATH = 64;

/**
 * Gives a serial port path that `modbus-rs` accepts.
 *
 * Stable device links, such as `/dev/serial/by-id/...`, can be longer than
 * {@link MAX_SERIAL_PORT_PATH}. Such a link points to a short device path,
 * so a long path is replaced with its target. The target is resolved at each
 * open, so a device that the system enumerates again is found again.
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
