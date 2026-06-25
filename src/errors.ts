import { Data } from "effect";
import { getModbusErrorCode, ModbusErrorCode } from "modbus-rs";

export class ModbusExceptionError extends Data.TaggedError("ModbusExceptionError")<{
  readonly cause: Error;
  readonly exception: number;
  readonly message: string;
}> {}

export class ModbusTimeoutError extends Data.TaggedError("ModbusTimeoutError")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export class ModbusTransportError extends Data.TaggedError("ModbusTransportError")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export class ModbusInvalidArgumentError extends Data.TaggedError("ModbusInvalidArgumentError")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export class ModbusConnectionClosedError extends Data.TaggedError("ModbusConnectionClosedError")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export class ModbusInternalError extends Data.TaggedError("ModbusInternalError")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export type ModbusError =
  | ModbusExceptionError
  | ModbusTimeoutError
  | ModbusTransportError
  | ModbusInvalidArgumentError
  | ModbusConnectionClosedError
  | ModbusInternalError;

function parseExceptionCode(message: string): number | undefined {
  const m = message.match(/\[MODBUS_EXCEPTION:(\d+)\]/);
  return m ? Number(m[1]) : undefined;
}

export const toModbusError = (cause: Error): ModbusError => {
  const code = getModbusErrorCode(cause);
  const message = cause.message;
  switch (code) {
    case ModbusErrorCode.EXCEPTION:
      return new ModbusExceptionError({
        cause,
        exception: parseExceptionCode(message) ?? 0,
        message,
      });
    case ModbusErrorCode.TIMEOUT:
      return new ModbusTimeoutError({ cause, message });
    case ModbusErrorCode.TRANSPORT:
      return new ModbusTransportError({ cause, message });
    case ModbusErrorCode.INVALID_ARGUMENT:
      return new ModbusInvalidArgumentError({ cause, message });
    case ModbusErrorCode.CONNECTION_CLOSED:
      return new ModbusConnectionClosedError({ cause, message });
    default:
      return new ModbusInternalError({ cause, message });
  }
};
