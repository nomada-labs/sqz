#!/usr/bin/env node

import { resolve, extname, basename, join } from 'path';
import { existsSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import os from 'os';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import pLimit from 'p-limit';
import { runInteractive } from '../lib/interactive.js';
import { processImage, compressToSize } from '../lib/processor.js';
import { readMetadata, displayMetadata } from '../lib/metadata.js';
import { printBanner, printResult, formatBytes } from '../lib/display.js';

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.tif', '.gif', '.heif', '.heic']);

// Recursive directory scan - checks isFile() to avoid symlinks/dirs with image extensions
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

async function resolveInputs(args) {
  const files = [];

  for (const arg of args) {
    const resolved = resolve(arg);
    if (!existsSync(resolved)) {
      console.log(chalk.yellow(`  Skipping: ${arg} (not found)`));
      continue;
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      await scanDir(resolved, files);
    } else if (stat.isFile()) {
      const ext = extname(resolved).toLowerCase();
      if (SUPPORTED.has(ext)) {
        files.push(resolved);
      } else {
        console.log(chalk.yellow(`  Skipping: ${arg} (unsupported format: ${ext})`));
      }
    } else {
      console.log(chalk.yellow(`  Skipping: ${arg} (not a regular file)`));
    }
  }

  return files;
}

async function main() {
  const args = process.argv.slice(2);

  printBanner();

  if (args.length === 0) {
    console.log(chalk.dim('  Usage: sqz <image or folder> [image2] [image3] ...'));
    console.log(chalk.dim('         sqz photo.jpg'));
    console.log(chalk.dim('         sqz ./photos/'));
    console.log(chalk.dim('         sqz *.png'));
    console.log();
    console.log(chalk.dim('  Supported: JPEG, PNG, WebP, AVIF, TIFF, GIF, HEIF'));
    process.exit(0);
  }

  const files = await resolveInputs(args);

  if (files.length === 0) {
    console.log(chalk.red('  No supported image files found.'));
    process.exit(1);
  }

  console.log(chalk.cyan(`  Found ${files.length} image${files.length > 1 ? 's' : ''}:`));
  for (const f of files) {
    const size = statSync(f).size;
    console.log(chalk.dim(`    ${basename(f)} (${formatBytes(size)})`));
  }
  console.log();

  let options = await runInteractive(files);
  console.log();

  // Handle Info route (F2.1)
  if (options.route === 'info') {
    const meta = await readMetadata(files[0]);
    displayMetadata(meta);

    const continueProcess = await confirm({
      message: 'Continue with processing?',
      default: false,
    });

    if (!continueProcess) process.exit(0);

    // Re-run interactive to pick a processing route
    options = await runInteractive(files);
    console.log();
  }

  // Parallel processing with p-limit (F1.3)
  const concurrency = Math.min(4, os.cpus().length);
  const limit = pLimit(concurrency);
  const showProgress = files.length > 1;

  const results = await Promise.all(
    files.map((file, i) =>
      limit(async () => {
        try {
          let result;

          if (options.targetSize) {
            // Target size route - use binary search
            result = await compressToSize(file, options.targetSize, options);
          } else {
            result = await processImage(file, options);
          }

          if (showProgress) {
            process.stdout.write(chalk.dim(`  [${i + 1}/${files.length}] `));
          } else {
            process.stdout.write('  ');
          }
          printResult(result);

          return { ok: true, ...result };
        } catch (err) {
          const prefix = showProgress ? chalk.dim(`  [${i + 1}/${files.length}] `) : '  ';
          console.log(prefix + chalk.red(`✗ ${basename(file)}: ${err.message}`));
          return { ok: false, file, error: err.message };
        }
      })
    )
  );

  // Summary for batch
  const successes = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.ok && r.skipped);
  const failures = results.filter((r) => !r.ok);

  if (results.length > 1 || failures.length > 0 || skipped.length > 0) {
    const totalBefore = successes.reduce((sum, r) => sum + r.originalSize, 0);
    const totalAfter = successes.reduce((sum, r) => sum + r.newSize, 0);
    const saved = totalBefore - totalAfter;
    const pct = totalBefore > 0 ? ((saved / totalBefore) * 100).toFixed(1) : '0.0';

    console.log();
    console.log(chalk.bold('  Summary'));
    console.log(chalk.dim('  ' + '─'.repeat(38)));

    const filesSummary = failures.length > 0
      ? `${results.length} (${successes.length} ok, ${failures.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''})`
      : skipped.length > 0
        ? `${results.length} (${successes.length} ok, ${skipped.length} skipped)`
        : `${results.length}`;

    console.log(`  Files:   ${filesSummary}`);

    if (successes.length > 0) {
      console.log(`  Before:  ${formatBytes(totalBefore)}`);
      console.log(`  After:   ${formatBytes(totalAfter)}`);
      console.log(`  Saved:   ${chalk.green(formatBytes(saved))} (${chalk.green(pct + '%')})`);
    }

    if (skipped.length > 0) {
      console.log();
      console.log(chalk.dim('  Skipped (target ≥ original):'));
      for (const r of skipped) {
        console.log(chalk.dim(`    ${basename(r.inputPath)}`));
      }
    }

    if (failures.length > 0) {
      console.log();
      console.log(chalk.red('  Failed:'));
      for (const r of failures) {
        console.log(chalk.red(`    ✗ ${basename(r.file)}: ${r.error}`));
      }
    }
  }

  // Non-zero exit if any failures (F1.3)
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(`  Error: ${err.message}`));
  process.exit(1);
});
