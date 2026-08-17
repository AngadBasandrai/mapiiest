// Draws the app icons. Run when the mark or the accent colour changes:
//
//   node scripts/make-icons.mjs
//
// The icons are committed, but they are generated rather than drawn by hand so
// they can be regenerated from the same numbers the app uses. No image library:
// a PNG is a zlib stream of scanlines wrapped in four chunks, which is less code
// than taking a dependency for it.
//
// Note this is not a favicon — the browser tab deliberately has none. These are
// the install icons a home-screen launcher needs, which is a different job.

import { deflateSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public')

const BG = [0x0b, 0x0d, 0x10]     // --bg, the same near-black as the map
const MARK = [0x58, 0xa6, 0xff]   // --accent, the blue the UI runs on

/* ── PNG encoding ───────────────────────────────────────────────────────── */

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** `rgba` is a size*size*4 Uint8Array. */
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: truecolour with alpha
  // Each scanline is prefixed with its filter type; 0 means "none", which zlib
  // compresses well enough for flat art like this.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── the mark ───────────────────────────────────────────────────────────── */

/**
 * A map pin: a disc with a tapered point below it, and a hole through the
 * middle. Coordinates are in a 0..1 square so one description serves every
 * size. `inset` shrinks the mark for the maskable variant, whose outer ~10% on
 * each edge can be cropped to a circle by the launcher.
 */
function pin(x, y, inset) {
  const s = 1 - inset * 2
  const u = (x - inset) / s, v = (y - inset) / s // 0..1 within the mark box
  if (u < 0 || u > 1 || v < 0 || v > 1) return false

  const cx = 0.5, cy = 0.38, r = 0.27
  const dx = u - cx, dy = v - cy
  const inDisc = dx * dx + dy * dy <= r * r
  // The point: a triangle from the disc's flanks down to the tip, narrowing
  // linearly so it meets the disc without a visible seam.
  const tipY = 0.94
  let inPoint = false
  if (v >= cy && v <= tipY) {
    const t = (v - cy) / (tipY - cy)
    const halfWidth = r * (1 - t)
    inPoint = Math.abs(dx) <= halfWidth
  }
  const hole = dx * dx + dy * dy <= (r * 0.4) ** 2
  return (inDisc || inPoint) && !hole
}

/** Rounded-square corner mask, for the plain (non-maskable) icon. */
function inSquircle(x, y, radius) {
  const dx = Math.max(radius - x, x - (1 - radius), 0)
  const dy = Math.max(radius - y, y - (1 - radius), 0)
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Renders one icon. 4x4 supersampling per pixel — flat art with a curve in it
 * looks obviously wrong at 192px without it.
 */
function render(size, { inset, rounded }) {
  const rgba = new Uint8Array(size * size * 4)
  const S = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let markHits = 0, bgHits = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size
          const y = (py + (sy + 0.5) / S) / size
          if (rounded && !inSquircle(x, y, 0.22)) continue
          bgHits++
          if (pin(x, y, inset)) markHits++
        }
      }
      const total = S * S
      const i = (py * size + px) * 4
      const alpha = bgHits / total
      const mark = markHits / total
      // Composite the mark over the background, then the whole thing over
      // transparency for the rounded corners.
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round((MARK[c] * mark + BG[c] * (alpha - mark)) / (alpha || 1))
      }
      rgba[i + 3] = Math.round(alpha * 255)
    }
  }
  return rgba
}

const ICONS = [
  // A launcher crops a maskable icon to whatever shape it likes, so that one is
  // full-bleed with the mark pulled into the safe centre.
  ['icon-192.png', 192, { inset: 0.16, rounded: true }],
  ['icon-512.png', 512, { inset: 0.16, rounded: true }],
  ['icon-maskable-512.png', 512, { inset: 0.26, rounded: false }],
  ['apple-touch-icon.png', 180, { inset: 0.16, rounded: false }],
]

await mkdir(OUT, { recursive: true })
for (const [name, size, opts] of ICONS) {
  const buf = png(size, render(size, opts))
  await writeFile(join(OUT, name), buf)
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)} kB`)
}
