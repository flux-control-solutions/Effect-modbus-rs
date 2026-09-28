---
'@flux-control/effect-modbus-rs': minor
---

Add `ModbusUnitAlreadyDeclaredError`. `withBatchingClient` now fails with this error when the unit already has a batching client. Before this change, it failed with `ModbusInvalidArgumentError`.

A declaration belongs to the transport scope. It stays when its caller is interrupted, and when the owner that made it closes while the transport stays open. The new tag lets that owner recover the existing client without also catching a bad address or quantity:

```ts
const client =
  yield *
  transport
    .withBatchingClient(3)
    .pipe(
      Effect.catchTag('ModbusUnitAlreadyDeclaredError', (error) =>
        transport.batchingClient(error.unitId),
      ),
    );
```

The error has a `unitId` field. It is not a member of the `ModbusError` union, because it never comes from the bus. Retry policies and the `ModbusErrorTag` type do not change.

`BatchingModbusClient` now has a `debounce` field of the new type `BatchingDebounceWindows`. It gives the windows that the client applies, as frozen `Duration` values, or `undefined` when the declaration had no `debounce` option. An omitted `maxHold` shows as four times the write window, which is the limit that the client applies. A caller that recovers a client can compare these windows with the windows that it expects.

Breaking changes:

- Code that catches `ModbusInvalidArgumentError` from `withBatchingClient` to detect a second declaration must catch `ModbusUnitAlreadyDeclaredError` instead.
- The error type of `withBatchingClient` is now `ModbusError | ModbusUnitAlreadyDeclaredError`. A custom implementation or a type annotation that uses `ModbusError` alone must add the new error. For example, a function annotated `Effect.Effect<BatchingModbusClient, ModbusError>` that returns the result of `withBatchingClient`, directly or through a cache, no longer typechecks. Either recover the existing client, as in the example above, or add `ModbusUnitAlreadyDeclaredError` to the annotation.
- A custom implementation of `BatchingModbusClient` must add the `debounce` field.
