#!/usr/bin/env node

/**
 * sqz MCP server - stdio transport
 * Provides programmatic access to sqz operations for AI coding tools and scripts.
 *
 * Tools: sqz_optimize, sqz_convert, sqz_info, sqz_write_meta, sqz_batch
 */

import { resolve, extname, join } from 'path';
import { existsSync, statSync } from 'fs';
import { readdir, realpath } from 'fs/promises';
import os from 'os';
import pLimit from 'p-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { processImage, compressToSize, parseTargetSize, buildPipelineForDryRun } from '../lib/processor.js';
import { readMetadata } from '../lib/metadata.js';
import { writeMetadata } from '../lib/mcp-tools.js';

// ── Path security ────────────────────────────────────────────────────────────

async function securePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('path is required');
  }

  // Reject obvious traversal patterns before resolving
  if (filePath.includes('..')) {
    throw new Error('Path traversal not permitted');
  }

  const resolved = resolve(filePath);

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  // Canonicalize (resolves symlinks, normalizes separators)
  const canonical = await realpath(resolved);

  // Verify it is a regular file (not a directory or symlink to a dir)
  const stat = statSync(canonical);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${canonical}`);
  }

  return canonical;
}

// ── Supported extensions ────────────────────────────────────────────────────

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.tif', '.gif', '.heif', '.heic']);

async function scanDir(dirPath, files = []) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await scanDir(full, files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (SUPPORTED.has(ext)) files.push(full);
    }
  }
  return files;
}

// ── Tool handlers ────────────────────────────────────────────────────────────

/**
 * sqz_optimize - compress a file to a target size or quality level.
 * Supports dry_run: true to preview without writing files.
 */
async function handleOptimize(args) {
  const { path: filePath, targetSize, quality, format, overwrite = false, dry_run = false } = args;

  const canonical = await securePath(filePath);

  const options = {
    format: format || 'webp',
    quality: quality !== undefined ? quality : 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  // Resolve target size string if provided
  let targetBytes = null;
  if (targetSize !== undefined) {
    if (typeof targetSize === 'number') {
      targetBytes = targetSize;
    } else {
      targetBytes = parseTargetSize(String(targetSize));
      if (targetBytes === null) {
        throw new Error(`Invalid targetSize: "${targetSize}". Use e.g. "500kb", "1mb", or a byte count.`);
      }
    }
  }

  if (dry_run) {
    // Use toBuffer() to measure - no files written
    return dryRunOptimize(canonical, targetBytes, options);
  }

  if (targetBytes !== null) {
    const result = await compressToSize(canonical, targetBytes, options);
    return formatResult(result);
  } else {
    const result = await processImage(canonical, options);
    return formatResult(result);
  }
}

/**
 * sqz_convert - convert a file to a different format.
 */
async function handleConvert(args) {
  const { path: filePath, format, quality, overwrite = false } = args;

  if (!format) throw new Error('format is required');

  const canonical = await securePath(filePath);

  const validFormats = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'];
  if (!validFormats.includes(format)) {
    throw new Error(`Invalid format "${format}". Supported: ${validFormats.join(', ')}`);
  }

  const options = {
    format,
    quality: quality !== undefined ? quality : 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  const result = await processImage(canonical, options);
  return formatResult(result);
}

/**
 * sqz_info - return image metadata as structured JSON.
 */
async function handleInfo(args) {
  const { path: filePath } = args;

  const canonical = await securePath(filePath);
  const meta = await readMetadata(canonical);
  return meta;
}

/**
 * sqz_write_meta - write metadata fields to an image.
 */
async function handleWriteMeta(args) {
  const { path: filePath, alt, copyright, title, description, overwrite = true } = args;

  if (!alt && !copyright && !title && !description) {
    throw new Error('At least one metadata field (alt, copyright, title, description) is required');
  }

  const canonical = await securePath(filePath);

  const result = await writeMetadata(canonical, { alt, copyright, title, description }, overwrite);
  return result;
}

/**
 * sqz_batch - process all images in a directory.
 * Supports dry_run: true.
 */
async function handleBatch(args) {
  const { directory, targetSize, format, quality, recursive = true, overwrite = false, dry_run = false } = args;

  if (!directory) throw new Error('directory is required');

  const resolvedDir = resolve(directory);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory not found: ${resolvedDir}`);
  }
  if (!statSync(resolvedDir).isDirectory()) {
    throw new Error(`Not a directory: ${resolvedDir}`);
  }

  let files;
  if (recursive) {
    files = await scanDir(resolvedDir);
  } else {
    const entries = await readdir(resolvedDir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && SUPPORTED.has(extname(e.name).toLowerCase()))
      .map(e => join(resolvedDir, e.name));
  }

  if (files.length === 0) {
    return { processed: 0, results: [], message: 'No supported image files found in directory' };
  }

  const options = {
    format: format || 'webp',
    quality: quality !== undefined ? quality : 80,
    effort: 'balanced',
    stripMeta: 'strip',
    overwrite,
    rename: null,
    extras: [],
    metadataWrite: null,
  };

  let targetBytes = null;
  if (targetSize !== undefined) {
    if (typeof targetSize === 'number') {
      targetBytes = targetSize;
    } else {
      targetBytes = parseTargetSize(String(targetSize));
      if (targetBytes === null) {
        throw new Error(`Invalid targetSize: "${targetSize}". Use e.g. "500kb", "1mb", or a byte count.`);
      }
    }
  }

  const concurrency = Math.min(4, os.cpus().length);
  const limit = pLimit(concurrency);

  const results = await Promise.all(
    files.map(file =>
      limit(async () => {
        try {
          if (dry_run) {
            return await dryRunOptimize(file, targetBytes, options);
          }
          let result;
          if (targetBytes !== null) {
            result = await compressToSize(file, targetBytes, options);
          } else {
            result = await processImage(file, options);
          }
          return { ok: true, ...formatResult(result) };
        } catch (err) {
          return { ok: false, file, error: err.message };
        }
      })
    )
  );

  const succeeded = results.filter(r => r.ok !== false);
  const failed = results.filter(r => r.ok === false);

  return {
    processed: files.length,
    succeeded: succeeded.length,
    failed: failed.length,
    results,
    ...(failed.length > 0 ? { errors: failed } : {}),
  };
}

// ── Dry run helper ────────────────────────────────────────────────────────────

async function dryRunOptimize(filePath, targetBytes, options) {
  // Uses toBuffer() only - never writes files
  const originalSize = statSync(filePath).size;

  const buffer = await buildPipelineForDryRun(filePath, options).toBuffer();
  const estimatedSize = buffer.length;

  return {
    dry_run: true,
    file: filePath,
    originalSize,
    estimatedSize,
    estimatedSavings: originalSize - estimatedSize,
    estimatedPercent: ((1 - estimatedSize / originalSize) * 100).toFixed(1),
    format: options.format,
    wouldWrite: false,
  };
}

// ── Result formatter ──────────────────────────────────────────────────────────

function formatResult(result) {
  if (result.skipped) {
    return {
      ok: true,
      skipped: true,
      reason: result.reason,
      file: result.inputPath,
      originalSize: result.originalSize,
    };
  }

  return {
    ok: true,
    inputPath: result.inputPath,
    outputPath: result.outputPath,
    originalSize: result.originalSize,
    newSize: result.newSize,
    saved: result.saved,
    percent: result.percent,
    format: result.format,
    width: result.width,
    height: result.height,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'sqz_optimize',
    description: 'Compress an image to a target size or quality level. Returns stats showing original/new size and savings. Use dry_run: true to preview without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
        targetSize: { description: 'Target file size as string ("500kb", "1mb") or byte count', oneOf: [{ type: 'string' }, { type: 'number' }] },
        quality: { type: 'number', minimum: 1, maximum: 100, description: 'Output quality (1-100). Ignored if targetSize is set.' },
        format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'], description: 'Output format (default: webp)' },
        overwrite: { type: 'boolean', description: 'Overwrite input file (default: false, creates .sqzed copy)' },
        dry_run: { type: 'boolean', description: 'Preview result without writing files (default: false)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sqz_convert',
    description: 'Convert an image to a different format.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
        format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'], description: 'Target format' },
        quality: { type: 'number', minimum: 1, maximum: 100, description: 'Output quality (1-100, default: 80)' },
        overwrite: { type: 'boolean', description: 'Overwrite input file (default: false)' },
      },
      required: ['path', 'format'],
    },
  },
  {
    name: 'sqz_info',
    description: 'Read image metadata - dimensions, format, color space, EXIF/XMP presence, animation frames.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sqz_write_meta',
    description: 'Write metadata fields to an image (alt text, copyright, title, description). Uses Sharp .withExifMerge() + .withXmp().',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the image file' },
        alt: { type: 'string', description: 'Alt text / image description (stored as XMP dc:description and EXIF ImageDescription)' },
        copyright: { type: 'string', description: 'Copyright notice (stored as EXIF Copyright and XMP dc:rights)' },
        title: { type: 'string', description: 'Image title (stored as XMP dc:title)' },
        description: { type: 'string', description: 'Extended description (stored as XMP dc:description)' },
        overwrite: { type: 'boolean', description: 'Overwrite input file (default: true for metadata writes)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sqz_batch',
    description: 'Process all images in a directory. Returns an array of per-file results. Use dry_run: true to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory path to scan for images' },
        targetSize: { description: 'Target size per image as string ("500kb") or byte count', oneOf: [{ type: 'string' }, { type: 'number' }] },
        format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'], description: 'Output format (default: webp)' },
        quality: { type: 'number', minimum: 1, maximum: 100, description: 'Output quality (1-100, default: 80)' },
        recursive: { type: 'boolean', description: 'Scan subdirectories recursively (default: true)' },
        overwrite: { type: 'boolean', description: 'Overwrite input files (default: false)' },
        dry_run: { type: 'boolean', description: 'Preview results without writing files (default: false)' },
      },
      required: ['directory'],
    },
  },
];

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'sqz', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'sqz_optimize':
        result = await handleOptimize(args || {});
        break;
      case 'sqz_convert':
        result = await handleConvert(args || {});
        break;
      case 'sqz_info':
        result = await handleInfo(args || {});
        break;
      case 'sqz_write_meta':
        result = await handleWriteMeta(args || {});
        break;
      case 'sqz_batch':
        result = await handleBatch(args || {});
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err.message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until process exits - no explicit close needed for stdio
