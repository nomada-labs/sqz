/**
 * Test suite for lib/display.js
 * formatBytes edge cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../lib/display.js';

test('formatBytes - zero', () => {
  assert.equal(formatBytes(0), '0 B');
});

test('formatBytes - bytes (< 1 KB)', () => {
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes - kilobytes boundary', () => {
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(512 * 1024), '512 KB');
});

test('formatBytes - just under 1 MB', () => {
  // 1023 * 1024 = 1047552
  const result = formatBytes(1047552);
  assert.ok(result.includes('KB'), `expected KB but got: ${result}`);
});

test('formatBytes - megabytes boundary', () => {
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
});

test('formatBytes - gigabytes', () => {
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB');
});

test('formatBytes - returns a string always', () => {
  [0, 1, 100, 1024, 1024 * 1024].forEach(n => {
    assert.equal(typeof formatBytes(n), 'string');
  });
});
