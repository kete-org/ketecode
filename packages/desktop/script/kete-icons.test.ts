import { describe, expect, test } from "bun:test"
import { decode, dimensions, draw, encode, icns, ico, resize } from "./kete-icons"

const solid = (size: number, rgba: [number, number, number, number]) => ({
  width: size,
  height: size,
  data: Uint8Array.from({ length: size * size * 4 }, (_, i) => rgba[i % 4]),
})

describe("kete-icons", () => {
  test("a PNG survives encode and decode, and its header gives its size", () => {
    const image = solid(3, [110, 71, 245, 255])
    const png = encode(image)
    expect(decode(png)).toEqual(image)
    expect(dimensions(png)).toEqual({ width: 3, height: 3 })
  })

  test("resizing averages colour by coverage, so transparent pixels don't darken edges", () => {
    const image = { width: 2, height: 1, data: Uint8Array.from([200, 100, 50, 255, 0, 0, 0, 0]) }
    expect([...resize(image, 1, 1).data]).toEqual([200, 100, 50, 128])
  })

  test("the macOS margin leaves the corners transparent and the centre opaque", () => {
    const icon = draw(solid(64, [10, 20, 30, 255]), 100, 824 / 1024)
    expect(icon.data[3]).toBe(0)
    expect(icon.data[(50 * 100 + 50) * 4 + 3]).toBe(255)
  })

  test("ico and icns headers count and size their images", () => {
    const png = encode(solid(1, [0, 0, 0, 255]))
    const file = ico([png, png], [16, 256])
    expect(file.readUInt16LE(4)).toBe(2)
    expect(file[6 + 16]).toBe(0)
    const mac = icns([["ic07", png]])
    expect(mac.toString("latin1", 0, 4)).toBe("icns")
    expect(mac.readUInt32BE(4)).toBe(mac.length)
  })
})
