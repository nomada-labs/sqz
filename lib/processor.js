import sharp from 'sharp';
import { extname, basename, dirname, join } from 'path';
import { statSync, rename as fsRename, unlink } from 'fs';
import { writeFile, rename, unlink as unlinkAsync } from 'fs/promises';

const EFFORT_MAP = {
  webp:  { fast: 1, balanced: 4, max: 6 },
  avif:  { fast: 1, balanced: 4, max: 9 },
};

// Animation-aware sharp constructor options
function getSharpOptions(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === '.gif' || ext === '.webp' || ext === '.tiff' || ext === '.tif') {
    return { animated: true };
  }
  return {};
}

export function getOutputPath(inputPath, options) {
  const dir = dirname(inputPath);
  const ext = options.format === 'jpeg' ? '.jpg' : `.${options.format}`;

  if (options.overwrite) {
    const inputExt = extname(inputPath).toLowerCase();
    const outputExt = ext.toLowerCase();
    if (inputExt !== outputExt && inputExt !== '.jpeg' && outputExt !== '.jpeg') {
      return join(dir, basename(inputPath, extname(inputPath)) + ext);
    }
    return inputPath;
  }

  if (options.rename) {
    return join(dir, options.rename + ext);
  }

  const name = basename(inputPath, extname(inputPath));
  return join(dir, `${name}.squished${ext}`);
}

// Build a Sharp pipeline without terminal operation (no .toFile / .toBuffer)
// maxWidth / maxHeight override resize when doing binary search dimension reduction
function buildPipeline(inputPath, options, maxWidth, maxHeight) {
  let pipeline = sharp(inputPath, getSharpOptions(inputPath));

  // Auto-rotate from EXIF
  if (options.extras && options.extras.includes('autoRotate')) {
    pipeline = pipeline.rotate();
  }

  // Resize (dimension reduction for compressToSize overrides options.resize)
  if (maxWidth || maxHeight) {
    pipeline = pipeline.resize({
      width: maxWidth || undefined,
      height: maxHeight || undefined,
      fit: 'inside',
      withoutEnlargement: true,
    });
  } else if (options.resize) {
    pipeline = pipeline.resize(options.resize);
  }

  // Extras
  if (options.extras) {
    if (options.extras.includes('grayscale')) {
      pipeline = pipeline.grayscale();
    }
    if (options.extras.includes('sharpen')) {
      pipeline = pipeline.sharpen({ sigma: 0.8 });
    }
    if (options.extras.includes('flatten')) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }
  }

  // Auto-flatten transparency for JPEG output (white background)
  const outputFormat = options.format;
  if (outputFormat === 'jpeg' && !(options.extras && options.extras.includes('flatten'))) {
    pipeline = pipeline.flatten({ background: '#ffffff' });
  }

  // Metadata handling
  if (options.stripMeta === 'orientation') {
    pipeline = pipeline.rotate(); // applies EXIF rotation, metadata still stripped
  } else if (options.stripMeta === 'keep') {
    pipeline = pipeline.keepMetadata();
  }
  // 'strip' = Sharp's default (strip all)

  // ICC profile (caller sets options.iccProfile for web/social presets)
  if (options.iccProfile) {
    pipeline = pipeline.withIccProfile(options.iccProfile);
  }

  // Metadata writing (F2.2)
  if (options.metadataWrite) {
    const mw = options.metadataWrite;
    const hasContent = mw.alt || mw.copyright || mw.description || mw.title;
    if (hasContent) {
      const exifFields = {};
      if (mw.alt) exifFields.ImageDescription = mw.alt;
      if (mw.copyright) exifFields.Copyright = mw.copyright;

      if (Object.keys(exifFields).length > 0) {
        pipeline = pipeline.withExifMerge({ IFD0: exifFields });
      }

      const xmpXml = buildXmpString(mw);
      pipeline = pipeline.withXmp(xmpXml);
    }
  }

  // Format + compression
  const formatOpts = {};
  switch (outputFormat) {
    case 'jpeg':
      formatOpts.quality = options.quality;
      formatOpts.mozjpeg = true;
      formatOpts.progressive = true;
      break;
    case 'png':
      formatOpts.compressionLevel = 9;
      formatOpts.palette = options.quality < 100;
      if (formatOpts.palette) {
        formatOpts.quality = options.quality;
      }
      formatOpts.adaptiveFiltering = true;
      break;
    case 'webp':
      formatOpts.quality = options.quality;
      formatOpts.effort = EFFORT_MAP.webp[options.effort || 'balanced'];
      formatOpts.lossless = options.quality === 100;
      break;
    case 'avif':
      formatOpts.quality = options.quality;
      formatOpts.effort = EFFORT_MAP.avif[options.effort || 'balanced'];
      formatOpts.lossless = options.quality === 100;
      break;
    case 'tiff':
      formatOpts.quality = options.quality;
      formatOpts.compression = 'lzw';
      break;
    default:
      formatOpts.quality = options.quality;
  }

  pipeline = pipeline.toFormat(outputFormat, formatOpts);
  return pipeline;
}

function buildXmpString({ alt, description, copyright, title }) {
  return `<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''
      xmlns:dc='http://purl.org/dc/elements/1.1/'
      xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
      ${alt ? `<dc:description><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(alt)}</rdf:li></rdf:Alt></dc:description>` : ''}
      ${title ? `<dc:title><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>` : ''}
      ${copyright ? `<dc:rights><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(copyright)}</rdf:li></rdf:Alt></dc:rights>` : ''}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Exported for dry-run use in MCP server - returns a pipeline without a terminal .toFile()/.toBuffer()
// Caller must call .toBuffer() on the returned pipeline to get the encoded output.
export function buildPipelineForDryRun(inputPath, options) {
  return buildPipeline(inputPath, options);
}

export function parseTargetSize(str) {
  const s = String(str).trim().toLowerCase();
  const match = s.match(/^([0-9.]+)\s*(kb|mb|gb|b)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2] || 'b';
  const multipliers = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Math.floor(num * multipliers[unit]);
}

export async function processImage(inputPath, options) {
  // Read metadata ONCE at top - fixes double-read bug (Codex finding)
  const metadata = await sharp(inputPath, getSharpOptions(inputPath)).metadata();
  const originalSize = statSync(inputPath).size;
  const outputPath = getOutputPath(inputPath, options);

  const pipeline = buildPipeline(inputPath, options);

  // Atomic overwrite: write to .tmp first, then rename on success
  if (outputPath === inputPath) {
    const tmpPath = inputPath + '.squish_tmp';
    try {
      const info = await pipeline.toFile(tmpPath);
      await rename(tmpPath, inputPath);
      const newSize = statSync(inputPath).size;
      return {
        inputPath,
        outputPath,
        originalSize,
        newSize,
        saved: originalSize - newSize,
        percent: ((1 - newSize / originalSize) * 100).toFixed(1),
        width: info.width,
        height: info.height,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        format: options.format,
      };
    } catch (err) {
      // Clean up tmp file if it exists
      try { await unlinkAsync(tmpPath); } catch (_) {}
      throw err;
    }
  }

  const info = await pipeline.toFile(outputPath);
  const newSize = statSync(outputPath).size;

  return {
    inputPath,
    outputPath,
    originalSize,
    newSize,
    saved: originalSize - newSize,
    percent: ((1 - newSize / originalSize) * 100).toFixed(1),
    width: info.width,
    height: info.height,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    format: options.format,
  };
}

export async function compressToSize(inputPath, targetBytes, options) {
  const originalSize = statSync(inputPath).size;

  // If target >= original, skip re-encoding
  if (targetBytes >= originalSize) {
    return { skipped: true, reason: 'Target size is larger than original', originalSize, inputPath };
  }

  // Read metadata once for dimension info
  const metadata = await sharp(inputPath, getSharpOptions(inputPath)).metadata();
  let currentWidth = metadata.width;
  let currentHeight = metadata.height;

  const outputPath = getOutputPath(inputPath, options);

  // Up to 3 passes: binary search on quality, then reduce dimensions by 10% per pass
  for (let pass = 0; pass < 3; pass++) {
    let minQ = 1;
    let maxQ = 95;
    let bestBuffer = null;
    let bestQuality = 1;

    for (let i = 0; i < 8; i++) {
      const midQ = Math.floor((minQ + maxQ) / 2);
      const buf = await buildPipeline(
        inputPath,
        { ...options, quality: midQ },
        currentWidth,
        currentHeight
      ).toBuffer();

      if (buf.length <= targetBytes) {
        bestBuffer = buf;
        bestQuality = midQ;
        minQ = midQ + 1;
      } else {
        maxQ = midQ - 1;
      }

      if (minQ > maxQ) break;
    }

    if (bestBuffer && bestBuffer.length <= targetBytes) {
      await writeFile(outputPath, bestBuffer);
      const newSize = bestBuffer.length;
      return {
        inputPath,
        outputPath,
        originalSize,
        newSize,
        saved: originalSize - newSize,
        percent: ((1 - newSize / originalSize) * 100).toFixed(1),
        quality: bestQuality,
        width: currentWidth,
        height: currentHeight,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        format: options.format,
      };
    }

    // Reduce dimensions by 10% for next pass
    currentWidth = Math.max(1, Math.floor(currentWidth * 0.9));
    currentHeight = Math.max(1, Math.floor(currentHeight * 0.9));
  }

  // Final fallback: write at quality 1 with reduced dimensions (best we can do)
  const fallbackBuf = await buildPipeline(
    inputPath,
    { ...options, quality: 1 },
    currentWidth,
    currentHeight
  ).toBuffer();

  await writeFile(outputPath, fallbackBuf);
  const newSize = fallbackBuf.length;

  return {
    inputPath,
    outputPath,
    originalSize,
    newSize,
    saved: originalSize - newSize,
    percent: ((1 - newSize / originalSize) * 100).toFixed(1),
    quality: 1,
    width: currentWidth,
    height: currentHeight,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    format: options.format,
    warning: 'Could not reach target size - output is smallest achievable',
  };
}
