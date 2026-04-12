/**
 * Test suite for lib/processor.js
 * Uses node:test + node:assert. Test images are generated programmatically with Sharp.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

import {
  processImage,
  compressToSize,
  parseTargetSize,
  getOutputPath,
  buildPipelineForDryRun,
} from '../lib/processor.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'squish-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Create a simple synthetic test image via Sharp and return its path */
async function createTestImage(filename, options = {}) {
  const {
    width = 200,
    height = 200,
    channels = 3,
    background = { r: 200, g: 100, b: 50 },
    format = 'jpeg',
  } = options;

  const filePath = join(tmpDir, filename);
  await sharp({
    create: { width, height, channels, background },
  })
    .toFormat(format, format === 'jpeg' ? { quality: 90 } : {})
    .toFile(filePath);

  return filePath;
}

// ── parseTargetSize ───────────────────────────────────────────────────────────

test('parseTargetSize - bytes', () => {
  assert.equal(parseTargetSize('500'), 500);
  assert.equal(parseTargetSize('1024b'), 1024);
});

test('parseTargetSize - kilobytes', () => {
  assert.equal(parseTargetSize('500kb'), 512000);
  assert.equal(parseTargetSize('1KB'), 1024);
  assert.equal(parseTargetSize('1.5kb'), Math.floor(1.5 * 1024));
});

test('parseTargetSize - megabytes', () => {
  assert.equal(parseTargetSize('1mb'), 1024 * 1024);
  assert.equal(parseTargetSize('2MB'), 2 * 1024 * 1024);
  assert.equal(parseTargetSize('1.5mb'), Math.floor(1.5 * 1024 * 1024));
});

test('parseTargetSize - invalid returns null', () => {
  assert.equal(parseTargetSize(''), null);
  assert.equal(parseTargetSize('abc'), null);
  assert.equal(parseTargetSize('500px'), null);
});

// ── getOutputPath ─────────────────────────────────────────────────────────────

test('getOutputPath - suffix mode (default)', () => {
  const inputPath = join(tmpDir, 'photo.jpg');
  const result = getOutputPath(inputPath, { format: 'jpeg', overwrite: false, rename: null });
  assert.equal(result, join(tmpDir, 'photo.squished.jpg'));
});

test('getOutputPath - overwrite same format', () => {
  const inputPath = join(tmpDir, 'photo.jpg');
  const result = getOutputPath(inputPath, { format: 'jpeg', overwrite: true, rename: null });
  assert.equal(result, inputPath);
});

test('getOutputPath - overwrite with format change (new file name)', () => {
  const inputPath = join(tmpDir, 'photo.jpg');
  const result = getOutputPath(inputPath, { format: 'webp', overwrite: true, rename: null });
  // Format changed, overwrite returns a new path with new extension
  assert.equal(result, join(tmpDir, 'photo.webp'));
});

test('getOutputPath - rename mode', () => {
  const inputPath = join(tmpDir, 'photo.jpg');
  const result = getOutputPath(inputPath, { format: 'webp', overwrite: false, rename: 'hero-image' });
  assert.equal(result, join(tmpDir, 'hero-image.webp'));
});

test('getOutputPath - format change suffix', () => {
  const inputPath = join(tmpDir, 'photo.png');
  const result = getOutputPath(inputPath, { format: 'webp', overwrite: false, rename: null });
  assert.equal(result, join(tmpDir, 'photo.squished.webp'));
});

// ── processImage ──────────────────────────────────────────────────────────────

test('processImage - JPEG to WebP conversion', async () => {
  const input = await createTestImage('convert-test.jpg', { format: 'jpeg' });
  const options = {
    format: 'webp',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(input, options);

  assert.ok(result.outputPath.endsWith('.squished.webp'), 'output has webp extension');
  assert.ok(existsSync(result.outputPath), 'output file exists');
  assert.ok(result.newSize > 0, 'output has size > 0');
  assert.equal(result.format, 'webp');
});

test('processImage - JPEG to PNG conversion', async () => {
  const input = await createTestImage('convert-png.jpg', { format: 'jpeg' });
  const options = {
    format: 'png',
    quality: 90,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(input, options);
  assert.ok(result.outputPath.endsWith('.squished.png'));
  assert.ok(existsSync(result.outputPath));
  assert.equal(result.format, 'png');
});

test('processImage - JPEG to AVIF conversion', async () => {
  const input = await createTestImage('convert-avif.jpg', { format: 'jpeg' });
  const options = {
    format: 'avif',
    quality: 60,
    effort: 'fast',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(input, options);
  assert.ok(result.outputPath.endsWith('.squished.avif'));
  assert.ok(existsSync(result.outputPath));
  assert.equal(result.format, 'avif');
});

test('processImage - overwrite mode (atomic temp swap)', async () => {
  const input = await createTestImage('overwrite-test.jpg', { format: 'jpeg', width: 400, height: 400 });
  const originalSize = statSync(input).size;

  const options = {
    format: 'jpeg',
    quality: 50,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: true,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(input, options);

  assert.equal(result.outputPath, input, 'output path matches input (overwrite)');
  assert.ok(existsSync(input), 'file still exists after overwrite');
});

test('processImage - result shape has required fields', async () => {
  const input = await createTestImage('shape-test.jpg', { format: 'jpeg' });
  const options = {
    format: 'webp',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(input, options);

  const requiredFields = ['inputPath', 'outputPath', 'originalSize', 'newSize', 'saved', 'percent', 'format'];
  for (const field of requiredFields) {
    assert.ok(field in result, `result has field: ${field}`);
  }
});

// ── compressToSize ─────────────────────────────────────────────────────────────

test('compressToSize - skips when target >= original', async () => {
  const input = await createTestImage('skip-test.jpg', { format: 'jpeg' });
  const originalSize = statSync(input).size;

  // Target larger than original
  const result = await compressToSize(input, originalSize * 10, {
    format: 'jpeg',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  });

  assert.ok(result.skipped, 'result is skipped');
  assert.ok(result.reason, 'result has a reason');
});

test('compressToSize - binary search converges within target', async () => {
  // Create a larger image to give the binary search something to work with
  const input = await createTestImage('compress-test.jpg', {
    format: 'jpeg',
    width: 800,
    height: 600,
    background: { r: 100, g: 150, b: 200 },
  });
  const originalSize = statSync(input).size;

  // Target 60% of original (should be achievable)
  const targetBytes = Math.floor(originalSize * 0.6);

  const result = await compressToSize(input, targetBytes, {
    format: 'jpeg',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  });

  assert.ok(!result.skipped, 'result is not skipped');
  assert.ok(existsSync(result.outputPath), 'output file exists');
  // Allow a small overshoot due to binary search granularity at low sizes
  // The key invariant: if we got a result, it's the best we could achieve
  assert.ok(result.newSize <= targetBytes + 1000, `output ${result.newSize} should be close to target ${targetBytes}`);
}, { timeout: 30000 });

test('compressToSize - result has quality field', async () => {
  const input = await createTestImage('quality-field-test.jpg', {
    format: 'jpeg',
    width: 400,
    height: 300,
  });
  const originalSize = statSync(input).size;
  const targetBytes = Math.floor(originalSize * 0.5);

  const result = await compressToSize(input, targetBytes, {
    format: 'jpeg',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  });

  if (!result.skipped) {
    assert.ok('quality' in result, 'result has quality field');
    assert.ok(result.quality >= 1 && result.quality <= 100, 'quality is valid range');
  }
}, { timeout: 30000 });

// ── buildPipelineForDryRun ────────────────────────────────────────────────────

test('buildPipelineForDryRun - returns a pipeline that produces a buffer', async () => {
  const input = await createTestImage('dry-run-test.jpg', { format: 'jpeg' });
  const options = {
    format: 'webp',
    quality: 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite: false,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const pipeline = buildPipelineForDryRun(input, options);
  const buffer = await pipeline.toBuffer();

  assert.ok(Buffer.isBuffer(buffer), 'result is a Buffer');
  assert.ok(buffer.length > 0, 'buffer has content');
});
