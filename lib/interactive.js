import { select, input, confirm, checkbox, Separator } from '@inquirer/prompts';
import { extname, basename } from 'path';
import chalk from 'chalk';
import { parseTargetSize } from './processor.js';
import { formatBytes } from './display.js';
import { statSync } from 'fs';

const FORMAT_MAP = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.avif': 'avif',
  '.tiff': 'tiff', '.tif': 'tiff',
  '.gif': 'gif',
  '.heif': 'heif', '.heic': 'heif',
};

// HEIC/HEIF is Apple-only, not web-compatible - always needs conversion
function isHeic(inputFormat) {
  return inputFormat === 'heif';
}

// Quality presets mapped to format-appropriate values
const QUALITY_PRESETS = {
  light:    { jpeg: 90, png: 95, webp: 88, avif: 80, tiff: 90 },
  balanced: { jpeg: 80, png: 80, webp: 78, avif: 63, tiff: 80 },
  heavy:    { jpeg: 60, png: 60, webp: 55, avif: 45, tiff: 60 },
};

function getQualityForPreset(preset, format) {
  const map = QUALITY_PRESETS[preset];
  return map[format] || map.jpeg;
}

function previewNewFilename(files, format) {
  const first = files[0];
  const name = basename(first, extname(first));
  const ext = format === 'jpeg' ? '.jpg' : `.${format}`;
  return `${name}.squished${ext}`;
}

export async function runInteractive(files) {
  const isSingle = files.length === 1;
  const inputExt = extname(files[0]).toLowerCase();
  const inputFormat = FORMAT_MAP[inputExt] || 'jpeg';
  const heic = isHeic(inputFormat);

  // Show file size context for size-limit users
  if (isSingle) {
    const size = statSync(files[0]).size;
    console.log(chalk.dim(`  Current size: ${formatBytes(size)}`));
    console.log();
  }

  // ── Step 1: What do you need? ──
  const goal = await select({
    message: 'What do you need?',
    choices: [
      { name: `Optimize         ${chalk.dim('- make it smaller, keep it looking good')}`, value: 'optimize' },
      { name: `Hit a size limit  ${chalk.dim('- squeeze under a specific file size (e.g. 500KB, 2MB)')}`, value: 'target' },
      { name: `Full control     ${chalk.dim('- pick format, quality, resize, metadata, and more')}`, value: 'full' },
      { name: `Info only        ${chalk.dim('- view image details, no processing')}`, value: 'info' },
    ],
  });

  if (goal === 'info') {
    return { route: 'info' };
  }

  // ── HEIC format gate ──
  // HEIC needs conversion for any route. For non-HEIC, keep original format.
  let format = inputFormat;

  if (heic) {
    format = await askHeicFormat();
  } else if (goal === 'full') {
    // Full control always offers format choice, but defaults to keep-original
    format = await askFormat(inputFormat);
  }
  // optimize and target routes: keep original format (unless HEIC)

  // ── Route: Optimize ──
  if (goal === 'optimize') {
    const compression = await select({
      message: 'How much compression?',
      choices: [
        { name: `Balanced  ${chalk.dim('- good quality, noticeably smaller')}`, value: 'balanced' },
        { name: `Light     ${chalk.dim('- barely any quality loss')}`, value: 'light' },
        { name: `Heavy     ${chalk.dim('- smallest file, some quality loss')}`, value: 'heavy' },
      ],
    });

    const quality = getQualityForPreset(compression, format);
    const overwrite = await askOverwrite(files, format);

    return {
      route: 'optimize',
      format,
      quality,
      effort: 'balanced',
      resize: null,
      stripMeta: 'strip',
      overwrite,
      rename: null,
      extras: [],
      targetSize: null,
      metadataWrite: null,
    };
  }

  // ── Route: Hit a size limit ──
  if (goal === 'target') {
    const targetSizeInput = await input({
      message: `Target file size?`,
      transformer: (v) => v ? v : chalk.dim('e.g. 500kb, 2mb, 200kb'),
      validate: (v) => {
        if (!v.trim()) return 'Enter a target size like 500kb, 2mb, 1.5mb';
        const parsed = parseTargetSize(v);
        return parsed !== null ? true : 'Enter a size like 500kb, 2mb, 1.5mb';
      },
    });

    const targetSize = parseTargetSize(targetSizeInput.trim());
    const overwrite = await askOverwrite(files, format);

    return {
      route: 'target',
      format,
      quality: 80, // starting point for binary search
      effort: 'balanced',
      resize: null,
      stripMeta: 'strip',
      overwrite,
      rename: null,
      extras: [],
      targetSize,
      metadataWrite: null,
    };
  }

  // ── Route: Full control ──
  const quality = await askQuality(80);

  let effort = 'balanced';
  if (format === 'webp' || format === 'avif') {
    effort = await select({
      message: 'Encoding effort? (more effort = smaller file, slower encode)',
      default: 'balanced',
      choices: [
        { name: `Fast     ${chalk.dim('- quick encode, slightly larger')}`, value: 'fast' },
        { name: `Balanced ${chalk.dim('- good tradeoff')}`, value: 'balanced' },
        { name: `Maximum  ${chalk.dim('- smallest possible, slow encode')}`, value: 'max' },
      ],
    });
  }

  const resizeChoice = await select({
    message: 'Resize?',
    default: 'none',
    choices: [
      { name: 'No resize - keep original dimensions', value: 'none' },
      new Separator('── Fit within max width ──'),
      { name: '800px   - thumbnail / email', value: 'max800' },
      { name: '1200px  - blog / social', value: 'max1200' },
      { name: '1500px  - social / general', value: 'max1500' },
      { name: '2000px  - web / retina', value: 'max2000' },
      { name: '3000px  - high-res web', value: 'max3000' },
      new Separator('── Custom ──'),
      { name: 'Custom dimensions...', value: 'custom' },
    ],
  });

  let resize = null;
  if (resizeChoice === 'custom') {
    const customWidth = await input({
      message: 'Max width (px, leave blank to skip):',
      validate: (v) => v === '' || parseInt(v) > 0 ? true : 'Enter a positive number or leave blank',
    });
    const customHeight = await input({
      message: 'Max height (px, leave blank to skip):',
      validate: (v) => v === '' || parseInt(v) > 0 ? true : 'Enter a positive number or leave blank',
    });
    if (customWidth || customHeight) {
      resize = {
        width: customWidth ? parseInt(customWidth) : undefined,
        height: customHeight ? parseInt(customHeight) : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      };
    }
  } else if (resizeChoice !== 'none') {
    const maxWidth = parseInt(resizeChoice.replace('max', ''));
    resize = { width: maxWidth, fit: 'inside', withoutEnlargement: true };
  }

  const stripMeta = await select({
    message: 'EXIF / metadata?',
    default: 'strip',
    choices: [
      { name: 'Strip all metadata (GPS, camera, dates, etc.)', value: 'strip' },
      { name: 'Keep orientation only', value: 'orientation' },
      { name: 'Keep all metadata', value: 'keep' },
    ],
  });

  const metadataWrite = await askMetadataWrite();
  const overwrite = await askOverwrite(files, format);

  // Rename (single file only, non-overwrite)
  let rename = null;
  if (!overwrite && isSingle) {
    const wantRename = await confirm({
      message: 'Rename the output file?',
      default: false,
    });

    if (wantRename) {
      const ext = format === 'jpeg' ? '.jpg' : `.${format}`;
      const newName = await input({
        message: `New filename (without extension, will get ${ext}):`,
        default: basename(files[0], extname(files[0])),
        validate: (v) => {
          if (!v.trim()) return 'Enter a filename';
          if (v.includes('/') || v.includes('\\') || v.includes('..')) {
            return 'Invalid filename';
          }
          return true;
        },
      });
      rename = newName.trim();
    }
  }

  // Extra transforms
  const extras = await checkbox({
    message: 'Any extra transforms? (space to select, enter to continue)',
    choices: [
      { name: 'Sharpen (subtle, good after downsizing)', value: 'sharpen' },
      { name: 'Grayscale / black & white', value: 'grayscale' },
      { name: 'Auto-rotate (fix phone orientation)', value: 'autoRotate' },
      { name: 'Flatten transparency (replace alpha with white)', value: 'flatten' },
    ],
  });

  return {
    route: 'full',
    format,
    quality,
    effort,
    resize,
    stripMeta,
    overwrite,
    rename,
    extras,
    targetSize: null,
    metadataWrite,
  };
}

// ── Shared prompts ──

async function askHeicFormat() {
  return select({
    message: `Output format? ${chalk.yellow('(HEIC is Apple-only - pick a compatible format)')}`,
    choices: [
      { name: `JPEG  ${chalk.dim('- universal, great for photos')}`, value: 'jpeg' },
      { name: `WebP  ${chalk.dim('- smaller files, wide browser support')}`, value: 'webp' },
      { name: `PNG   ${chalk.dim('- lossless, transparency')}`, value: 'png' },
      { name: `AVIF  ${chalk.dim('- smallest files, slower to encode')}`, value: 'avif' },
    ],
  });
}

function askFormat(inputFormat) {
  return select({
    message: 'Output format?',
    choices: [
      { name: `Keep original (${inputFormat})`, value: inputFormat },
      new Separator('── Modern formats ──'),
      { name: `WebP  ${chalk.dim('- best balance of size/quality')}`, value: 'webp' },
      { name: `AVIF  ${chalk.dim('- smallest files, slow to encode')}`, value: 'avif' },
      new Separator('── Classic formats ──'),
      { name: `JPEG  ${chalk.dim('- universal compatibility, photos')}`, value: 'jpeg' },
      { name: `PNG   ${chalk.dim('- lossless, transparency')}`, value: 'png' },
      { name: `TIFF  ${chalk.dim('- print/archive')}`, value: 'tiff' },
    ],
  });
}

async function askOverwrite(files, format) {
  const newFilePreview = previewNewFilename(files, format);
  return select({
    message: 'Save as...',
    choices: [
      { name: `New file  ${chalk.dim(`(${newFilePreview})`)}`, value: false },
      { name: 'Overwrite original', value: true },
    ],
  });
}

async function askQuality(defaultQuality) {
  const qualityChoice = await select({
    message: 'Quality level?',
    default: defaultQuality,
    choices: [
      { name: `Low        (60) ${chalk.dim('- smallest files, visible artifacts')}`, value: 60 },
      { name: `Medium     (75) ${chalk.dim('- good balance for web')}`, value: 75 },
      { name: `High       (85) ${chalk.dim('- hard to tell from original')}`, value: 85 },
      { name: `Very high  (92) ${chalk.dim('- near-lossless')}`, value: 92 },
      { name: `Maximum   (100) ${chalk.dim('- no quality loss')}`, value: 100 },
      { name: `Custom    (...) ${chalk.dim('- enter a number 1-100')}`, value: -1 },
    ],
  });

  if (qualityChoice === -1) {
    const customQuality = await input({
      message: 'Quality (1-100):',
      default: '80',
      validate: (v) => {
        const n = parseInt(v);
        return n >= 1 && n <= 100 ? true : 'Enter a number between 1 and 100';
      },
    });
    return parseInt(customQuality);
  }

  return qualityChoice;
}

async function askMetadataWrite() {
  const wantMeta = await confirm({
    message: 'Add metadata to output? (alt text, copyright, title)',
    default: false,
  });

  if (!wantMeta) return null;

  const alt = await input({
    message: `Alt text / description: ${chalk.dim('(leave blank to skip)')}`,
  });

  const copyright = await input({
    message: `Copyright: ${chalk.dim('(leave blank to skip)')}`,
  });

  const title = await input({
    message: `Title: ${chalk.dim('(leave blank to skip)')}`,
  });

  const mw = {
    alt: alt.trim() || null,
    copyright: copyright.trim() || null,
    title: title.trim() || null,
  };

  if (!mw.alt && !mw.copyright && !mw.title) return null;
  return mw;
}
