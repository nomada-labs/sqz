import chalk from 'chalk';
import { basename } from 'path';

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function printBanner() {
  console.log();
  console.log(chalk.bold.cyan('  sqz') + chalk.dim(' - local image optimizer'));
  console.log(chalk.dim('  compress, convert, strip metadata. no uploads, no limits.'));
  console.log();
}

export function printResult(result) {
  const arrow = result.saved > 0 ? chalk.green('\u2193') : chalk.yellow('\u2191');
  const pctText = result.saved > 0
    ? chalk.green(`-${result.percent}%`)
    : chalk.yellow(`+${Math.abs(result.percent)}%`);

  const dimChange = result.originalWidth !== result.width || result.originalHeight !== result.height
    ? chalk.dim(` ${result.originalWidth}x${result.originalHeight} -> ${result.width}x${result.height}`)
    : '';

  console.log(
    `  ${arrow} ${chalk.bold(basename(result.outputPath))}` +
    `  ${formatBytes(result.originalSize)} -> ${formatBytes(result.newSize)}` +
    `  ${pctText}` +
    dimChange
  );
}
