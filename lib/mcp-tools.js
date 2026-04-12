/**
 * MCP-specific tool helpers.
 * writeMetadata - write EXIF/XMP fields to an image without full re-compression.
 */

import sharp from 'sharp';
import { statSync } from 'fs';
import { writeFile, rename, unlink } from 'fs/promises';
import { extname, basename } from 'path';

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXmpString({ alt, description, copyright, title }) {
  const desc = alt || description;
  return `<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''
      xmlns:dc='http://purl.org/dc/elements/1.1/'
      xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
      ${desc ? `<dc:description><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(desc)}</rdf:li></rdf:Alt></dc:description>` : ''}
      ${title ? `<dc:title><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>` : ''}
      ${copyright ? `<dc:rights><rdf:Alt><rdf:li xml:lang='x-default'>${escapeXml(copyright)}</rdf:li></rdf:Alt></dc:rights>` : ''}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
}

/**
 * Write metadata fields to an image file using Sharp.
 * If overwrite is true, uses atomic temp-file swap.
 * If overwrite is false, writes to <name>.squished<ext>.
 */
export async function writeMetadata(filePath, fields, overwrite = true) {
  const { alt, copyright, title, description } = fields;
  const originalSize = statSync(filePath).size;

  const ext = extname(filePath).toLowerCase();
  const format = ext === '.jpg' || ext === '.jpeg' ? 'jpeg'
    : ext === '.png' ? 'png'
    : ext === '.webp' ? 'webp'
    : ext === '.avif' ? 'avif'
    : ext === '.tiff' || ext === '.tif' ? 'tiff'
    : null;

  if (!format) {
    throw new Error(`Unsupported format for metadata writing: ${ext}`);
  }

  let pipeline = sharp(filePath).keepMetadata();

  // EXIF fields
  const exifFields = {};
  if (alt) exifFields.ImageDescription = alt;
  if (copyright) exifFields.Copyright = copyright;

  if (Object.keys(exifFields).length > 0) {
    pipeline = pipeline.withExifMerge({ IFD0: exifFields });
  }

  // XMP fields
  const xmpXml = buildXmpString({ alt, description, copyright, title });
  pipeline = pipeline.withXmp(xmpXml);

  // Format options - preserve quality via lossless for metadata-only writes where possible
  const formatOpts = format === 'jpeg' ? { quality: 92, mozjpeg: true }
    : format === 'png' ? { compressionLevel: 6 }
    : format === 'webp' ? { lossless: true }
    : format === 'avif' ? { lossless: true }
    : {};

  pipeline = pipeline.toFormat(format, formatOpts);

  let outputPath;
  if (overwrite) {
    const tmpPath = filePath + '.squish_tmp';
    try {
      await pipeline.toFile(tmpPath);
      await rename(tmpPath, filePath);
      outputPath = filePath;
    } catch (err) {
      try { await unlink(tmpPath); } catch (_) {}
      throw err;
    }
  } else {
    const nameWithoutExt = basename(filePath, ext);
    const dir = filePath.slice(0, filePath.length - basename(filePath).length);
    outputPath = `${dir}${nameWithoutExt}.squished${ext}`;
    await pipeline.toFile(outputPath);
  }

  const newSize = statSync(outputPath).size;

  return {
    ok: true,
    inputPath: filePath,
    outputPath,
    originalSize,
    newSize,
    fieldsWritten: Object.fromEntries(
      Object.entries({ alt, copyright, title, description }).filter(([, v]) => v)
    ),
  };
}
