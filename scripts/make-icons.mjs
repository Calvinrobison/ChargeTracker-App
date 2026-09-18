#!/usr/bin/env node
/**
 * Generates the application icon set.
 *
 * `electron-builder.yml` points at `resources/icons/icon.ico`, and the main
 * process resolves the same file for the window and the tray. Without it,
 * packaging fails; with a placeholder that Windows cannot parse, packaging
 * succeeds and the installed application has a blank icon in the taskbar, the
 * Start menu and the tray — which is worse, because it looks like a corrupted
 * install.
 *
 * So the icon is GENERATED rather than committed as a binary blob: the source
 * of truth is this file, the output is reproducible, and nobody has to trust a
 * checked-in binary they cannot read.
 *
 * The design is a charging connector over a clock face — the two things the
 * application is about — in the interface's own accent colour. It is
 * deliberately plain: it is a real, working icon and an honest placeholder, not
 * a claim that anyone has done brand design.
 *
 * Everything here is written from scratch with `zlib` — no image library, so it
 * runs with nothing installed, like the rest of the no-dependency tooling.
 *
 * Usage:
 *   node scripts/make-icons.mjs            # write resources/icons/
 *   node scripts/make-icons.mjs --check    # verify the files exist and parse
 */

import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'resources', 'icons');

// The interface's accent and background, from src/renderer/src/tokens.css.
const BACKGROUND = [0x13, 0x1d, 0x1a];
const ACCENT = [0x5d, 0xbb, 0x97];
const ACCENT_BRIGHT = [0x86, 0xe0, 0xba];

// Windows uses these; the ICO carries all of them so the taskbar, the Start
// menu, Explorer and the tray each get a properly sized image rather than a
// scaled one.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Renders the icon at `size` into an RGBA buffer.
 *
 * Supersampled 4x and box-filtered down, because a 16px icon drawn directly
 * has visibly ragged diagonals.
 */
function render(size) {
  const ss = 4;
  const big = size * ss;
  const acc = new Float64Array(big * big * 4);

  const c = big / 2;
  const radius = big * 0.46;
  const ringOuter = radius;
  const ringInner = radius * 0.84;

  const put = (x, y, rgb, alpha) => {
    if (alpha <= 0) return;
    const i = (y * big + x) * 4;
    // Source-over, premultiplied by alpha on the fly.
    const a = Math.min(1, alpha);
    acc[i] = acc[i] * (1 - a) + rgb[0] * a;
    acc[i + 1] = acc[i + 1] * (1 - a) + rgb[1] * a;
    acc[i + 2] = acc[i + 2] * (1 - a) + rgb[2] * a;
    acc[i + 3] = Math.min(255, acc[i + 3] * (1 - a) + 255 * a);
  };

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const dist = Math.hypot(dx, dy);

      // Rounded-square body with a soft edge.
      if (dist <= radius) put(x, y, BACKGROUND, 1);

      // The ring: the clock face, meaning "over time".
      if (dist <= ringOuter && dist >= ringInner) put(x, y, ACCENT, 0.9);
    }
  }

  // The bolt, as a filled polygon in normalised coordinates. Drawn after the
  // ring so it sits on top of it.
  const bolt = [
    [0.56, 0.16],
    [0.3, 0.55],
    [0.46, 0.55],
    [0.4, 0.86],
    [0.7, 0.44],
    [0.53, 0.44],
    [0.6, 0.16],
  ].map(([px, py]) => [px * big, py * big]);

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      if (pointInPolygon(x + 0.5, y + 0.5, bolt)) put(x, y, ACCENT_BRIGHT, 1);
    }
  }

  // Box-filter down to the target size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * big + (x * ss + sx)) * 4;
          r += acc[i];
          g += acc[i + 1];
          b += acc[i + 2];
          a += acc[i + 3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A minimal 8-bit RGBA PNG. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte per scanline. Filter 0 (none) keeps this readable; the
  // images are small enough that a smarter filter would not earn its cost.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO
// ---------------------------------------------------------------------------

/**
 * A PNG-compressed ICO.
 *
 * Windows Vista and later read PNG-compressed entries, which is what lets the
 * 256x256 image be included without a 256 KB BMP. electron-builder also parses
 * this format.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  const payloads = [];

  images.forEach((image, index) => {
    const entry = 16 * index;
    // 256 is stored as 0, per the format.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32BE(0, entry + 8); // placeholder, rewritten below
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
    payloads.push(image.png);
  });

  return Buffer.concat([header, directory, ...payloads]);
}

// ---------------------------------------------------------------------------

const check = process.argv.includes('--check');

if (check) {
  const problems = [];
  const icoPath = join(outDir, 'icon.ico');

  if (!existsSync(icoPath)) {
    problems.push(`${icoPath} is missing. Run: npm run make:icons`);
  } else {
    const bytes = readFileSync(icoPath);
    if (bytes.length < 100) problems.push('icon.ico is too small to be a real icon.');
    else if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
      problems.push('icon.ico does not start with a valid ICO header.');
    } else {
      const count = bytes.readUInt16LE(4);
      if (count < 1) problems.push('icon.ico declares no images.');
      else
        console.log(`icon.ico carries ${count} image(s), ${(bytes.length / 1024).toFixed(1)} KB`);
    }
  }

  for (const size of [256, 512]) {
    const path = join(outDir, `icon-${size}.png`);
    if (!existsSync(path)) problems.push(`${path} is missing.`);
  }

  if (problems.length > 0) {
    console.error('\nIcon check failed:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('Icons are present and parse.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const images = SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));
writeFileSync(join(outDir, 'icon.ico'), encodeIco(images));

// Standalone PNGs: Linux packaging wants one, and the 512 is useful for docs.
for (const size of [256, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), encodePng(render(size), size));
}

console.log(`Wrote ${outDir}:`);
console.log(`  icon.ico        ${SIZES.join(', ')} px`);
console.log('  icon-256.png');
console.log('  icon-512.png');
