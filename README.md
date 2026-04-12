# sqz

Compress images locally. No uploads. No limits.

```
npm install -g sqz
```

---

## How it works

```
$ sqz photo.jpg

  sqz - local image optimizer

  Found 1 image:
    photo.jpg (3.2 MB)

  Current size: 3.2 MB

? What do you need?
> Optimize          - make it smaller, keep it looking good
  Hit a size limit  - squeeze under a specific file size (e.g. 500KB, 2MB)
  Full control      - pick format, quality, resize, metadata, and more
  Info only         - view image details, no processing
```

Answer a couple of questions. Get a smaller file. Done.

---

## Why local?

Every other image optimizer is a website you upload to. sqz runs on your machine.

- **No uploads.** Your files never leave your disk.
- **No limits.** No "5 free compressions per day." No subscription. No account.
- **No waiting.** No round-trips. Just fast, local processing.
- **No sketchy websites.** You know the ones.

---

## Routes

### Optimize

Make it smaller, keep it looking good. Three prompts.

```
$ sqz hero.png

? What do you need? Optimize

? How much compression?
> Balanced  - good quality, noticeably smaller
  Light     - barely any quality loss
  Heavy     - smallest file, some quality loss

? Save as...
> New file (hero.squished.png)
  Overwrite original

  hero.squished.png  3.2 MB -> 890 KB  -72%
```

Your format stays the same. PNG in, PNG out. No surprises.

### Hit a size limit

Need a file under 500KB for an upload form? sqz uses binary search to nail the target every time.

```
$ sqz headshot.jpg

? What do you need? Hit a size limit

? Target file size? 200kb

? Save as... New file (headshot.squished.jpg)

  headshot.squished.jpg  2.8 MB -> 198 KB  -93%
```

### Full control

Format, quality (0-100), effort, resize, metadata strip/write, rename, extras. Everything.

```
$ sqz raw-export.jpg

? What do you need? Full control
? Output format? AVIF
? Quality level? High (85)
? Resize? 1200px
? EXIF / metadata? Strip all
? Add metadata? Yes
? Alt text: Product shot on white background
? Save as... New file

  raw-export.squished.avif  4.1 MB -> 187 KB  -95%
```

### Info only

View image details without processing.

```
$ sqz mystery-photo.heic

  mystery-photo.heic
  ----------------------------------------
  Format:      HEIF
  Dimensions:  4032 x 3024px
  File size:   5.8 MB
  Color space: srgb
  DPI:         72
  EXIF:        present
```

### HEIC handling

HEIC is Apple's default photo format, but almost nothing on the web supports it. sqz detects HEIC files and prompts you to pick a compatible output format.

```
? Output format? (HEIC is Apple-only - pick a compatible format)
> JPEG  - universal, great for photos
  WebP  - smaller files, wide browser support
  PNG   - lossless, transparency
  AVIF  - smallest files, slower to encode
```

---

## Batch processing

Point sqz at a folder. It processes everything in parallel, handles errors per-file, and one bad image never stops the rest.

```
$ sqz ./product-images/

  Found 47 images

? What do you need? Hit a size limit
? Target file size? 200kb
? Save as... New file

  [1/47] banner.jpg       1.2 MB -> 189 KB
  [2/47] hero.png         3.1 MB -> 197 KB
  ...

  Summary
  Files:   47
  Before:  142 MB
  After:   9.2 MB
  Saved:   132.8 MB (93.5%)
```

Directories are scanned recursively by default.

---

## MCP server (AI tool integration)

sqz ships an MCP server so AI coding tools can compress and convert images in your project without you lifting a finger.

### Setup

Add sqz to your MCP configuration:

```json
{
  "mcpServers": {
    "sqz": {
      "command": "sqz-mcp"
    }
  }
}
```

Or with npx if sqz isn't installed globally:

```json
{
  "mcpServers": {
    "sqz": {
      "command": "npx",
      "args": ["sqz-mcp"]
    }
  }
}
```

Restart your editor/tool after editing settings.

### Tools

**sqz_optimize** - compress to target size or quality

```json
{ "path": "src/assets/hero.jpg", "targetSize": "200kb", "format": "webp" }
```

**sqz_convert** - change format

```json
{ "path": "logo.png", "format": "webp", "quality": 90 }
```

**sqz_info** - read metadata and dimensions

```json
{ "path": "photo.jpg" }
```

**sqz_write_meta** - write alt text, copyright, title

```json
{ "path": "hero.jpg", "alt": "Developer at a standing desk", "copyright": "2024 Acme Inc" }
```

**sqz_batch** - process a whole directory

```json
{ "directory": "src/assets", "targetSize": "150kb", "format": "webp", "recursive": true }
```

Every write tool supports `"dry_run": true` to estimate sizes without writing anything.

---

## Supported formats

**Input:** JPEG, PNG, WebP, AVIF, TIFF, GIF, HEIC/HEIF

**Output:** JPEG, PNG, WebP, AVIF, TIFF

---

## Requirements

Node.js >= 20.12.0

---

## License

MIT
