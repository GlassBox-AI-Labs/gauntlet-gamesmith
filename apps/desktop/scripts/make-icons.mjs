#!/usr/bin/env node
/**
 * Rebuild the packaged app icons from `build/icon.png`.
 *
 * electron-builder can convert a lone PNG itself, but it does so on a machine
 * we do not control at release time. Committing the .icns and .ico instead
 * means the shipped icon is the one that was reviewed.
 *
 * `icon.png` is the 1024x1024 master: the source artwork cropped out of its
 * mockup and re-laid onto the macOS Big Sur grid (an 824px squircle, corner
 * radius 185, centred on a 1024 canvas, with the drop shadow baked in).
 *
 * Usage: node scripts/make-icons.mjs
 * Needs: iconutil (macOS) and ImageMagick's `magick` on PATH.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')
const master = path.join(buildDir, 'icon.png')
if (!fs.existsSync(master)) throw new Error(`No master icon at ${master}`)

const run = (bin, args) => execFileSync(bin, args, { stdio: 'inherit' })

// macOS wants every size named exactly this, in a folder ending in .iconset.
const iconset = path.join(buildDir, 'icon.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  run('magick', [master, '-resize', `${size}x${size}`, path.join(iconset, `icon_${size}x${size}.png`)])
  run('magick', [master, '-resize', `${size * 2}x${size * 2}`, path.join(iconset, `icon_${size}x${size}@2x.png`)])
}
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')])
fs.rmSync(iconset, { recursive: true, force: true })

// Windows reads the largest frame that fits, so ship the whole ladder.
run('magick', [master, '-define', 'icon:auto-resize=256,128,64,48,32,24,16', path.join(buildDir, 'icon.ico')])

console.log('Wrote icon.icns and icon.ico')
