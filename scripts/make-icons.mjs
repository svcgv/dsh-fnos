import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { root } from './build.mjs'

const SCALE = 4
const SAMPLES = 3

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
  const px = x1 + t * dx
  const py = y1 + t * dy
  return Math.hypot(x - px, y - py)
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  return Math.hypot(x - cx, y - cy) <= radius
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const top = [29, 78, 216]
  const bottom = [13, 148, 136]
  const glyph = [255, 255, 255]
  const stroke = size * 0.085
  const inset = size * 0.045
  const radius = size * 0.22

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0
      let glyphHits = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES
          const py = y + (sy + 0.5) / SAMPLES
          if (!insideRoundedRect(px, py, inset, inset, size - inset, size - inset, radius)) continue
          hits += 1

          const chevron = Math.min(
            distanceToSegment(px, py, size * 0.30, size * 0.30, size * 0.47, size * 0.50),
            distanceToSegment(px, py, size * 0.47, size * 0.50, size * 0.30, size * 0.70),
          )
          const bar = distanceToSegment(px, py, size * 0.56, size * 0.70, size * 0.72, size * 0.70)
          if (chevron <= stroke / 2 || bar <= stroke / 2) glyphHits += 1
        }
      }

      const total = SAMPLES * SAMPLES
      const baseAlpha = hits / total
      const glyphAlpha = glyphHits / total
      const color = mix(top, bottom, y / size)
      const blended = mix(color, glyph, baseAlpha === 0 ? 0 : glyphAlpha / baseAlpha)
      const index = (y * size + x) * 4
      pixels[index] = blended[0]
      pixels[index + 1] = blended[1]
      pixels[index + 2] = blended[2]
      pixels[index + 3] = Math.round(baseAlpha * 255)
    }
  }
  return pixels
}

async function write(relative, size) {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, encodePng(size, render(size)))
  console.log(`icons: ${relative} (${size}x${size})`)
}

await write('packaging/fpk/ICON.PNG', 64)
await write('packaging/fpk/ICON_256.PNG', 256)
await write('packaging/fpk/app/ui/images/icon_64.png', 64)
await write('packaging/fpk/app/ui/images/icon_256.png', 256)
