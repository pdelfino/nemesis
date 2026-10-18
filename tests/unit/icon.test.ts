import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The mark (#91): resources/logo.svg is the source and scripts/icon.mjs
// generates every raster. The rasters are committed, so this reads the files
// in the checkout and asserts the set is complete and each PNG is the size its
// name claims, by its header rather than by trusting the file name.
const resources = join(import.meta.dirname, '../../resources')
const SIZES = [16, 32, 64, 128, 256, 512, 1024]
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngHeader(file: string) {
  const bytes = readFileSync(file)
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`).toBe(true)
  // Signature (8), then the IHDR chunk: length (4), type (4), width (4), height (4), depth, color type.
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  }
}

describe('the generated icon set', () => {
  it('has the source SVG', () => {
    const svg = readFileSync(join(resources, 'logo.svg'), 'utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 512 512"')
  })

  it.each(SIZES)('has a %i px PNG of that size, with an alpha channel', (size) => {
    const header = pngHeader(join(resources, `icon-${size}.png`))
    expect(header.width).toBe(size)
    expect(header.height).toBe(size)
    // Colour type 6 is RGBA: the Dock composites the mark over its background.
    expect(header.colorType).toBe(6)
  })

  it('has the macOS .icns built from those PNGs', () => {
    const file = join(resources, 'icon.icns')
    expect(existsSync(file)).toBe(true)
    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(bytes.length)
  })
})
