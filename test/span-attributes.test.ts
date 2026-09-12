import { expect, test } from 'bun:test';

import { mergeSpanAttributes } from '../src/span-attributes';

test('a single caller keeps each span attribute scalar unchanged', () => {
  expect(mergeSpanAttributes([{ attempts: 2, active: false, point: 'Supply' }])).toEqual({
    attempts: 2,
    active: false,
    point: 'Supply',
  });
});

test('repeated keys join every caller value in first-seen order', () => {
  expect(
    mergeSpanAttributes([
      { point: 'Supply', attempt: 1 },
      { point: 'Exhaust', attempt: 2 },
    ]),
  ).toEqual({ point: 'Supply,Exhaust', attempt: '1,2' });

  expect(mergeSpanAttributes([{ point: 'Supply' }, { point: 'Supply' }])).toEqual({
    point: 'Supply',
  });
});

test('undefined callers are ignored', () => {
  expect(mergeSpanAttributes([undefined, { point: 'Supply' }, undefined])).toEqual({
    point: 'Supply',
  });
});
