---
'@flux-control/effect-modbus-rs': minor
---

Make the request time limit of the native RTU, ASCII, and TCP transports work, and keep one silent unit from stopping the other units on a bus.

In `modbus-rs` 0.16.1, the serial `responseTimeoutMs` open option does not limit a request. A request to a unit that does not answer waits forever, and every later request on the bus waits behind it. These changes work around the binding:

- The transport applies `responseTimeoutMs` (serial) or `requestTimeoutMs` (TCP) with `setRequestTimeout` after each open.
- A request timeout closes the native handle for every unit. The next attempt now reconnects the handle before it is sent. A request that fails behind the timeout with a closed connection does not start the reconnect supervisor.
- The native time limit starts when a request enters the native queue. When a time limit is set, the transport now sends one native request at a time, so each request gets its full time limit. A native call is not interrupted, and a reconnect waits until the request in flight ends.
- `modbus-rs` refuses serial port paths longer than 64 characters. The native serial transports now replace a longer path with its link target. When the target is also too long, the open fails with `ModbusInvalidArgumentError` and a message that names the limit. `resolveSerialPortPath` and `MAX_SERIAL_PORT_PATH` are exported.

The WASM transports do not change.
