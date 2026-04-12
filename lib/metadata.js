import sharp from 'sharp';
import chalk from 'chalk';
import { statSync } from 'fs';
import { basename, extname } from 'path';
import { formatBytes } from './display.js';

function getSharpOptions(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.gif' || ext === '.webp' || ext === '.tiff' || ext === '.tif') {
    return { animated: true };
  }
  return {};
}

export async function readMetadata(filePath) {
  const meta = await sharp(filePath, getSharpOptions(filePath)).metadata();
  const stat = statSync(filePath);

  return {
    filePath,
    fileSize: stat.size,
    format: meta.format,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    density: meta.density,
    hasAlpha: meta.hasAlpha,
    isAnimated: (meta.pages || 0) > 1,
    pages: meta.pages || 1,
    exif: meta.exif ? { present: true } : null,
    icc: meta.icc ? true : false,
    xmp: meta.xmp ? meta.xmp.toString() : null,
  };
}

export function displayMetadata(meta) {
  console.log();
  console.log(chalk.bold(`  ${basename(meta.filePath)}`));
  console.log(chalk.dim(`  ${'─'.repeat(40)}`));
  console.log(`  Format:      ${(meta.format || 'unknown').toUpperCase()}`);
  console.log(`  Dimensions:  ${meta.width} × ${meta.height}px`);
  console.log(`  File size:   ${formatBytes(meta.fileSize)}`);
  if (meta.space)   console.log(`  Color space: ${meta.space}`);
  if (meta.density) console.log(`  DPI:         ${meta.density}`);
  if (meta.hasAlpha) console.log(`  Alpha:       yes`);
  if (meta.isAnimated) console.log(`  Animated:    yes (${meta.pages} frames)`);
  if (meta.icc)     console.log(`  ICC profile: yes`);
  if (meta.exif?.present) console.log(`  EXIF:        present`);
  if (meta.xmp)     console.log(`  XMP:         present`);
  console.log();
}

// Smart format recommendation based on image characteristics (F2.3)
export function recommendFormat(meta) {
  // Keep original format for animated images - conversion loses frames
  if (meta.isAnimated) return meta.format;

  // Images with transparency: WebP handles it well and compresses better than PNG
  if (meta.hasAlpha) return 'webp';

  // Flat PNGs (no alpha) are usually better as WebP
  if (meta.format === 'png') return 'webp';

  // Photos and everything else: WebP is almost always the best trade-off
  return 'webp';
}
