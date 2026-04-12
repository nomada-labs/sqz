/**
 * Test suite for lib/metadata.js
 * Metadata read/write round-trip tests.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

import { readMetadata, recommendFormat } from '../lib/metadata.js';
import { writeMetadata } from '../lib/mcp-tools.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'squish-meta-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function createTestImage(filename, options = {}) {
  const {
    width = 150,
    height = 150,
    channels = 3,
    background = { r: 80, g: 120, b: 200 },
    format = 'jpeg',
    hasAlpha = false,
  } = options;

  const filePath = join(tmpDir, filename);
  const ch = hasAlpha ? 4 : channels;
  const bg = hasAlpha
    ? { r: background.r, g: background.g, b: background.b, alpha: 1 }
    : background;

  await sharp({ create: { width, height, channels: ch, background: bg } })
    .toFormat(format, format === 'jpeg' ? { quality: 85 } : {})
    .toFile(filePath);

  return filePath;
}

// ── readMetadata ──────────────────────────────────────────────────────────────

test('readMetadata - returns expected shape for JPEG', async () => {
  const filePath = await createTestImage('meta-shape.jpg', { format: 'jpeg' });
  const meta = await readMetadata(filePath);

  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 150);
  assert.equal(meta.height, 150);
  assert.ok(typeof meta.fileSize === 'number' && meta.fileSize > 0);
  assert.ok(typeof meta.hasAlpha === 'boolean');
  assert.ok(typeof meta.isAnimated === 'boolean');
});

test('readMetadata - PNG with alpha reports hasAlpha: true', async () => {
  const filePath = await createTestImage('alpha.png', {
    format: 'png',
    hasAlpha: true,
    channels: 4,
  });
  const meta = await readMetadata(filePath);
  assert.equal(meta.hasAlpha, true);
  assert.equal(meta.format, 'png');
});

test('readMetadata - static image reports isAnimated: false', async () => {
  const filePath = await createTestImage('static.jpg', { format: 'jpeg' });
  const meta = await readMetadata(filePath);
  assert.equal(meta.isAnimated, false);
  assert.equal(meta.pages, 1);
});

test('readMetadata - WebP image readable', async () => {
  const filePath = await createTestImage('meta-webp.webp', { format: 'webp' });
  const meta = await readMetadata(filePath);
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width > 0);
  assert.ok(meta.height > 0);
});

// ── writeMetadata round-trip ─────────────────────────────────────────────────

test('writeMetadata - writes alt text (EXIF ImageDescription), readable back via Sharp', async () => {
  const filePath = await createTestImage('write-alt.jpg', { format: 'jpeg' });

  const writeResult = await writeMetadata(filePath, {
    alt: 'A test image for unit testing',
  }, true);

  assert.ok(writeResult.ok, 'writeMetadata succeeded');
  assert.equal(writeResult.outputPath, filePath, 'overwrote original');

  // Read back and confirm EXIF is present
  const meta = await readMetadata(filePath);
  assert.ok(meta.exif !== null, 'EXIF data present after write');
});

test('writeMetadata - result shape has required fields', async () => {
  const filePath = await createTestImage('write-shape.jpg', { format: 'jpeg' });

  const result = await writeMetadata(filePath, {
    alt: 'Shape test',
    copyright: '2024 Test Corp',
  }, true);

  assert.ok(result.ok);
  assert.ok('inputPath' in result);
  assert.ok('outputPath' in result);
  assert.ok('originalSize' in result);
  assert.ok('newSize' in result);
  assert.ok('fieldsWritten' in result);
  assert.ok('alt' in result.fieldsWritten);
  assert.ok('copyright' in result.fieldsWritten);
});

test('writeMetadata - creates new file when overwrite: false', async () => {
  const filePath = await createTestImage('write-newfile.jpg', { format: 'jpeg' });

  const result = await writeMetadata(filePath, {
    title: 'New file test',
  }, false);

  assert.ok(result.ok);
  assert.notEqual(result.outputPath, filePath, 'created a different output file');
  assert.ok(result.outputPath.includes('.squished'));
});

// ── recommendFormat ───────────────────────────────────────────────────────────

test('recommendFormat - photos recommend webp', () => {
  const meta = { isAnimated: false, hasAlpha: false, format: 'jpeg' };
  assert.equal(recommendFormat(meta), 'webp');
});

test('recommendFormat - images with alpha recommend webp', () => {
  const meta = { isAnimated: false, hasAlpha: true, format: 'png' };
  assert.equal(recommendFormat(meta), 'webp');
});

test('recommendFormat - animated images keep original format', () => {
  const meta = { isAnimated: true, hasAlpha: false, format: 'gif' };
  assert.equal(recommendFormat(meta), 'gif');
});

test('recommendFormat - flat PNG recommends webp', () => {
  const meta = { isAnimated: false, hasAlpha: false, format: 'png' };
  assert.equal(recommendFormat(meta), 'webp');
});
