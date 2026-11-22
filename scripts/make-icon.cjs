// Regenerates build/icon.ico and build/icon.png from the SVG sources.
// Run with `npm run icon` (it needs Electron, which is used here as an SVG rasterizer).
//
// build/icon.svg        the logo, used for 32px and up
// build/icon-small.svg  heavier strokes, used for 16–24px so it stays crisp
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const BUILD = path.join(__dirname, '..', 'build')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const SMALL_MAX = 24

/** Runs in the page: rasterize an SVG string to a PNG data URL of the given size. */
function rasterize(svg, size) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(img, 0, 0, size, size)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('could not load SVG'))
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(sized)))
  })
}

/** Packs PNG images into a .ico file (PNG-compressed entries, Windows Vista and later). */
function toIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o) // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1) // height
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((img) => img.png)])
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false })
    await win.loadURL('data:text/html,<!doctype html><body></body>')
    const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8')
    const small = fs.readFileSync(path.join(BUILD, 'icon-small.svg'), 'utf8')
    const png = async (source, size) => {
      const url = await win.webContents.executeJavaScript(`(${rasterize})(${JSON.stringify(source)}, ${size})`)
      return Buffer.from(url.split(',')[1], 'base64')
    }

    const images = []
    for (const size of ICO_SIZES) images.push({ size, png: await png(size <= SMALL_MAX ? small : svg, size) })
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), toIco(images))
    fs.writeFileSync(path.join(BUILD, 'icon.png'), await png(svg, 512))
    console.log(`wrote build/icon.ico (${ICO_SIZES.join(', ')} px) and build/icon.png (512 px)`)
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
