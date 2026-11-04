#!/usr/bin/env bun
// Regenerates every desktop icon (icons/{dev,beta,prod}) from Kete Code's logo in assets/brand
// (docs/desktop.md "Icons"). Each existing PNG is redrawn at its own size, so every slot upstream's
// packaging expects stays filled; icon.ico and icon.icns are rebuilt with PNG images inside. macOS
// draws an app icon at 824/1024 of its canvas, so icon.icns and dock.png get that margin; the other
// platforms take the logo edge to edge, as upstream's icons do.
//
// No image library: PNGs are decoded and encoded here (8-bit RGBA, non-interlaced, which is what the
// brand file is) and resized by area averaging on premultiplied alpha, so edges get no light halo.
//
//   bun run script/kete-icons.ts [source.png]

import { inflateSync, deflateSync } from "node:zlib"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

type Image = { width: number; height: number; data: Uint8Array }

const root = path.resolve(import.meta.dir, "..")
const source = path.resolve(process.argv[2] ?? path.join(root, "../../assets/brand/kete-logo-512.png"))
const channels = ["dev", "beta", "prod"] as const
const MAC_BODY = 824 / 1024

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decode(file: Uint8Array): Image {
  const buffer = Buffer.from(file)
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG")
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("latin1", offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]]
      if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error("only 8-bit RGBA, non-interlaced PNGs are supported")
    }
    if (type === "IDAT") idat.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0
      const b = y > 0 ? data[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4] : 0
      const value = line[x]
      data[y * stride + x] =
        filter === 0
          ? value
          : filter === 1
            ? value + a
            : filter === 2
              ? value + b
              : filter === 3
                ? value + ((a + b) >> 1)
                : value + paeth(a, b, c)
    }
  }
  return { width, height, data }
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc(bytes: Buffer) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}

export function encode(image: Image): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

/** Area-averaging resize on premultiplied alpha. */
export function resize(image: Image, width: number, height: number): Image {
  const data = new Uint8Array(width * height * 4)
  const sx = image.width / width
  const sy = image.height / height
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const x0 = x * sx
      const x1 = x0 + sx
      const y0 = y * sy
      const y1 = y0 + sy
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let area = 0
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++)
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const weight = (Math.min(px + 1, x1) - Math.max(px, x0)) * (Math.min(py + 1, y1) - Math.max(py, y0))
          if (weight <= 0) continue
          const i = (Math.min(py, image.height - 1) * image.width + Math.min(px, image.width - 1)) * 4
          const alpha = image.data[i + 3] / 255
          r += image.data[i] * alpha * weight
          g += image.data[i + 1] * alpha * weight
          b += image.data[i + 2] * alpha * weight
          a += alpha * weight
          area += weight
        }
      const o = (y * width + x) * 4
      data[o + 3] = Math.round((a / area) * 255)
      if (a > 0) {
        data[o] = Math.round(r / a)
        data[o + 1] = Math.round(g / a)
        data[o + 2] = Math.round(b / a)
      }
    }
  return { width, height, data }
}

/** The logo at `size`, drawn `scale` of the canvas wide and centred on transparency. */
export function draw(logo: Image, size: number, scale = 1): Image {
  const body = Math.round(size * scale)
  if (body === size) return resize(logo, size, size)
  const inner = resize(logo, body, body)
  const data = new Uint8Array(size * size * 4)
  const offset = Math.floor((size - body) / 2)
  for (let y = 0; y < body; y++) data.set(inner.data.subarray(y * body * 4, (y + 1) * body * 4), ((y + offset) * size + offset) * 4)
  return { width: size, height: size, data }
}

/** A Windows .ico holding PNG images (Windows Vista and later). */
export function ico(images: Buffer[], sizes: number[]) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((image, index) => {
    const entry = 6 + 16 * index
    header[entry] = sizes[index] >= 256 ? 0 : sizes[index]
    header[entry + 1] = sizes[index] >= 256 ? 0 : sizes[index]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([header, ...images])
}

/** A macOS .icns holding PNG images, keyed by their OSType. */
export function icns(entries: Array<[string, Buffer]>) {
  const parts = entries.map(([type, png]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, "latin1")
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write("icns", 0, "latin1")
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

const ICNS_TYPES: Array<[string, number]> = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** A PNG's size from its IHDR chunk, whatever its colour type. */
export function dimensions(file: Uint8Array) {
  const buffer = Buffer.from(file)
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG")
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function pngs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".png")).map((entry) => path.join(entry.parentPath, entry.name))
}

if (import.meta.main) {
  const logo = decode(await readFile(source))
  for (const channel of channels) {
    const directory = path.join(root, "icons", channel)
    for (const file of await pngs(directory)) {
      const { width, height } = dimensions(await readFile(file))
      const mac = path.basename(file) === "dock.png"
      await writeFile(file, encode(width === height ? draw(logo, width, mac ? MAC_BODY : 1) : resize(logo, width, height)))
    }
    await writeFile(path.join(directory, "icon.ico"), ico(ICO_SIZES.map((size) => encode(draw(logo, size))), ICO_SIZES))
    await writeFile(path.join(directory, "icon.icns"), icns(ICNS_TYPES.map(([type, size]) => [type, encode(draw(logo, size, MAC_BODY))])))
    console.log(`icons/${channel}: regenerated from ${path.relative(process.cwd(), source)}`)
  }
}
