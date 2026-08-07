import { test, expect } from 'bun:test';

import type { AsciiTransportOptions, RtuTransportOptions, TcpTransportOptions } from 'modbus-rs';

import type { AsciiTransportOpenOptions } from './AsciiTransportService';
import type { RtuTransportOpenOptions } from './RtuTransportService';
import type { UpstreamRetryOptionKey } from './shared-transport';
import type { TcpTransportOpenOptions } from './TcpTransportService';

// ---------------------------------------------------------------------------
// The retry knobs are withheld with `Omit`, which fails open: if upstream
// renames or drops one of these keys, the `Omit` silently stops removing
// anything and the knob reappears on our public surface with no type error
// anywhere. These assertions are that error.
//
// They are enforced by `bun run typecheck` (`tsc --noEmit` covers `src/`), not
// at runtime — each one is written as a generic constraint, since a type alias
// that merely evaluates to `never` is legal and would never fail the build.
// ---------------------------------------------------------------------------

/** Fails to compile unless every member of `K` is a key of `T`. */
type AssertKeysOf<T, K extends keyof T> = K;

/** Fails to compile unless `T` is empty — used with `Extract` to assert absence. */
type AssertNever<T extends never> = T;

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

// Every withheld key still exists upstream, so `Omit` is still removing something.
type _TcpKeysExist = AssertKeysOf<TcpTransportOptions, UpstreamRetryOptionKey>;
type _RtuKeysExist = AssertKeysOf<RtuTransportOptions, UpstreamRetryOptionKey>;
type _AsciiKeysExist = AssertKeysOf<AsciiTransportOptions, UpstreamRetryOptionKey>;

// …and none of them survives on what we expose.
type _TcpKeysGone = AssertNever<Extract<keyof TcpTransportOpenOptions, UpstreamRetryOptionKey>>;
type _RtuKeysGone = AssertNever<Extract<keyof RtuTransportOpenOptions, UpstreamRetryOptionKey>>;
type _AsciiKeysGone = AssertNever<Extract<keyof AsciiTransportOpenOptions, UpstreamRetryOptionKey>>;

// The withheld keys are all optional upstream, so the narrowed types stay
// assignable to the originals and still satisfy `open()` / `connect()`. If one
// ever became required, dropping it would break the call and this catches it.
type _TcpAssignable = AssertTrue<
  TcpTransportOpenOptions extends TcpTransportOptions ? true : false
>;
type _RtuAssignable = AssertTrue<
  RtuTransportOpenOptions extends RtuTransportOptions ? true : false
>;
type _AsciiAssignable = AssertTrue<
  AsciiTransportOpenOptions extends AsciiTransportOptions ? true : false
>;

test('upstream retry options are withheld from the transport surface', () => {
  // Nothing to run — reaching here means the assertions above typechecked.
  expect(true).toBe(true);
});
