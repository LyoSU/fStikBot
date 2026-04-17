#!/usr/bin/env node
/**
 * Banner build script.
 * Reads HTML templates from banners/src/ and exports high-DPI PNG renders
 * into banners/dist/. Run: `npm run banners:build` (or `node banners/build.js`).
 *
 * Puppeteer is a devDependency — the resulting PNGs are what the bot ships,
 * so production Docker never touches a browser.
 */

const fs = require('fs')
const path = require('path')

let puppeteer
try {
  puppeteer = require('puppeteer')
} catch (err) {
  console.error('\n[banners] puppeteer is not installed.')
  console.error('Run once:  npm install --save-dev puppeteer\n')
  process.exit(1)
}

const WIDTH = 960
const HEIGHT = 360
const SCALE = 2 // retina output → 1920×720, looks crisp on high-DPI devices

const SRC = path.join(__dirname, 'src')
const DIST = path.join(__dirname, 'dist')

// Banners to build. Add a new entry when you create a new template.
// `name` becomes the output filename (dist/<name>.png).
// `width`/`height` override the defaults for banners that ship at different
// aspect ratios (e.g. Telegram's description picture is 640×360, not 960×360).
const BANNERS = [
  { name: 'welcome',     file: 'welcome.html' },
  { name: 'packs',       file: 'packs.html' },
  { name: 'catalog',     file: 'catalog.html' },
  { name: 'new-pack',    file: 'new-pack.html' },
  { name: 'boost',       file: 'boost.html' },
  { name: 'help',        file: 'help.html' },
  { name: 'donate',      file: 'donate.html' },
  { name: 'origin',      file: 'origin.html' },
  { name: 'publish',     file: 'publish.html' },
  { name: 'language',    file: 'language.html' },
  { name: 'emoji',       file: 'emoji.html' },
  { name: 'group',       file: 'group.html' },
  { name: 'mosaic',      file: 'mosaic.html' },
  { name: 'description', file: 'description.html', width: 640, height: 360 }
]

async function main () {
  fs.mkdirSync(DIST, { recursive: true })

  const browser = await puppeteer.launch({
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE }
  })

  try {
    for (const { name, file, width, height } of BANNERS) {
      const src = path.join(SRC, file)
      if (!fs.existsSync(src)) {
        console.warn(`[banners] skip ${name}: ${file} not found`)
        continue
      }
      const w = width || WIDTH
      const h = height || HEIGHT
      const page = await browser.newPage()
      await page.setViewport({ width: w, height: h, deviceScaleFactor: SCALE })

      const url = 'file://' + src
      const missing = []
      page.on('requestfailed', req => {
        const u = req.url()
        if (u.startsWith('file://') && !u.endsWith('.html')) missing.push(u)
      })

      await page.goto(url, { waitUntil: 'networkidle0' })

      // Wait for web fonts (Google Fonts via <link>) to actually load before shot.
      await page.evaluate(() => document.fonts.ready)

      if (missing.length) {
        console.warn(`[banners]   ⚠ ${name} is missing local assets:`)
        missing.forEach(u => console.warn('     ' + u.replace('file://', '')))
      }

      const out = path.join(DIST, `${name}.png`)
      await page.screenshot({
        path: out,
        clip: { x: 0, y: 0, width: w, height: h },
        omitBackground: false
      })
      await page.close()

      const bytes = fs.statSync(out).size
      console.log(`[banners] ✓ ${name.padEnd(10)} → ${path.relative(process.cwd(), out)}  (${(bytes / 1024).toFixed(1)} KB)`)
    }
  } finally {
    await browser.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
