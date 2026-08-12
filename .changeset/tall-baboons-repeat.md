---
'@flux-control/effect-modbus-rs': minor
---

Widen the options of the two abstract serial tags to agree with the concrete tags.

`SerialTransportService.makeMockTransport` did not accept `MockFaultOptions`.
`WasmSerialTransportService.makeMockTransport` accepted neither `MockFaultOptions`
nor `TransportResilienceOptions`. The mock factory honors all of these options at
runtime, but a caller that used one of these two tags could not give them by name.

`WasmSerialTransportService.fromAscii` and `WasmSerialTransportService.fromRtu` had
the same problem: they omitted `TransportResilienceOptions`, although the concrete
browser services accept `retry` and `reconnect`. The native `SerialTransportService`
providers already accepted them.

A consumer that does not select RTU framing or ASCII framing uses these abstract
tags. Before this release, that consumer could not drive a retry or a circuit
transition in a test without a cast. Now the abstract tags accept the same options
as the concrete tags:

```ts
SerialTransportService.makeMockTransport(devices)({
  portPath: 'mock',
  baudRate: 9600,
  retry: RetryPolicies.serial(),
  fault: () => new ModbusTimeoutError({ message: 'timeout', cause: new Error('timeout') }),
});
```

This change adds to the types only. There is no runtime change, and no existing
call becomes a type error. `src/mock-options.test.ts` holds a compile-time
assertion that each of the eight `makeMockTransport` statics accepts `retry`,
`reconnect`, `fault`, and `reconnectFault`. This test stops the same divergence
in the future.
