# Emoji Mosaic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mosaic mode that splits photos into custom emoji grids, uploads them to the user's pack, and sends a copyable mosaic message in chat.

**Architecture:** New Telegraf scene (`mosaic`) with a looping flow: wait for photo → show grid preview → split & upload → send mosaic → repeat. Three utility modules handle grid math, preview generation, and image splitting. Integrates with existing pack menu via a new button for custom_emoji packs.

**Tech Stack:** Telegraf v3 scenes, Sharp (image processing), MongoDB/Mongoose (sticker count queries), Telegram Bot API (uploadStickerFile, addStickerToSet, sendMessage with custom_emoji entities)

**Spec:** `docs/superpowers/specs/2026-04-05-emoji-mosaic-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `utils/mosaic-grid.js` | Create | Grid recommendation algorithm (aspect ratio → rows/cols suggestions) |
| `utils/mosaic-preview.js` | Create | Sharp: generate preview image with dashed grid overlay |
| `utils/mosaic-split.js` | Create | Sharp: split image into NxM cells, each 100×100 WEBP |
| `scenes/mosaic.js` | Create | Scene with looping flow: waitPhoto → waitGrid → upload → result → loop |
| `scenes/index.js` | Modify | Register mosaic scene in Stage |
| `handlers/packs.js` | Modify | Add "Mosaic" button for custom_emoji packs |
| `locales/en.yaml` | Modify | English strings for mosaic feature |
| `locales/uk.yaml` | Modify | Ukrainian strings for mosaic feature |

---

### Task 1: Grid Recommendation Algorithm (`utils/mosaic-grid.js`)

**Files:**
- Create: `utils/mosaic-grid.js`

This is a pure function with no external dependencies — good starting point.

- [ ] **Step 1: Create `utils/mosaic-grid.js` with `getGridSuggestions`**

```javascript
const getGridSuggestions = (width, height, freeSlots = 200) => {
  const ratio = width / height

  // Determine type
  if (ratio >= 2.5) return getStripSuggestions(ratio, 'horizontal', freeSlots)
  if (ratio <= 0.4) return getStripSuggestions(1 / ratio, 'vertical', freeSlots)
  return getGridOptions(ratio, freeSlots)
}

const getStripSuggestions = (ratio, direction, freeSlots) => {
  const count = Math.max(3, Math.min(10, Math.round(ratio)))
  const isHorizontal = direction === 'horizontal'

  const options = []
  for (let delta = -2; delta <= 2; delta++) {
    const n = count + delta
    if (n < 3 || n > 10 || n > freeSlots) continue
    const rows = isHorizontal ? 1 : n
    const cols = isHorizontal ? n : 1
    options.push({ rows, cols, total: n })
  }

  if (options.length === 0) return { type: 'no_space', options: [] }

  const recommended = options.find(o => o.total === count) || options[Math.floor(options.length / 2)]
  const alternatives = options.filter(o => o !== recommended).slice(0, 3)

  return { type: 'strip', recommended, alternatives }
}

const getGridOptions = (ratio, freeSlots) => {
  const candidates = []

  for (let rows = 2; rows <= 10; rows++) {
    for (let cols = 2; cols <= 10; cols++) {
      const total = rows * cols
      if (total > 50 || total > freeSlots) continue

      const gridRatio = cols / rows
      const ratioScore = Math.abs(gridRatio - ratio) / ratio
      // How close each cell is to square (1:1)
      const cellRatio = (ratio / gridRatio)
      const squareScore = Math.abs(1 - cellRatio)
      // Prefer medium-sized grids
      const sizeScore = Math.abs(total - 12) / 50

      const score = ratioScore * 2 + squareScore + sizeScore * 0.5
      candidates.push({ rows, cols, total, score })
    }
  }

  if (candidates.length === 0) return { type: 'no_space', options: [] }

  candidates.sort((a, b) => a.score - b.score)

  const recommended = candidates[0]
  // Pick alternatives: one smaller, one medium, one larger than recommended
  const smaller = candidates.find(c => c.total < recommended.total && c !== recommended)
  const larger = candidates.find(c => c.total > recommended.total && c !== recommended)
  const largest = candidates.find(c => c.total > (larger?.total || 0) && c !== recommended && c !== larger)

  const alternatives = [smaller, larger, largest].filter(Boolean).slice(0, 3)

  return { type: 'grid', recommended, alternatives }
}

module.exports = { getGridSuggestions }
```

- [ ] **Step 2: Manual test with node REPL**

Run: `cd /Users/ly/dev/fStikBot && node -e "const {getGridSuggestions} = require('./utils/mosaic-grid'); console.log(JSON.stringify(getGridSuggestions(1200, 800), null, 2)); console.log(JSON.stringify(getGridSuggestions(2000, 400), null, 2)); console.log(JSON.stringify(getGridSuggestions(800, 800), null, 2)); console.log(JSON.stringify(getGridSuggestions(600, 1200), null, 2))"`

Expected:
- 1200×800 (3:2 landscape) → type: "grid", recommended ~3×4 or 2×3
- 2000×400 (5:1 panorama) → type: "strip", recommended 1×5
- 800×800 (square) → type: "grid", recommended ~3×3
- 600×1200 (1:2 portrait) → type: "grid", recommended ~4×2 or similar

- [ ] **Step 3: Commit**

```bash
git add utils/mosaic-grid.js
git commit -m "feat(mosaic): add grid recommendation algorithm"
```

---

### Task 2: Preview Generation (`utils/mosaic-preview.js`)

**Files:**
- Create: `utils/mosaic-preview.js`

**Depends on:** Nothing (standalone Sharp utility)

- [ ] **Step 1: Create `utils/mosaic-preview.js`**

```javascript
const sharp = require('sharp')

const generatePreview = async (imageBuffer, rows, cols) => {
  const image = sharp(imageBuffer, {
    failOnError: false,
    limitInputPixels: false
  })

  const metadata = await image.metadata()

  // Resize to max 512px on longest side for preview
  const scale = Math.min(512 / metadata.width, 512 / metadata.height, 1)
  const previewWidth = Math.round(metadata.width * scale)
  const previewHeight = Math.round(metadata.height * scale)

  // Use floor-based coordinates to match actual split boundaries
  // (same math as splitImage uses on the original)
  const cellW = Math.floor(previewWidth / cols)
  const cellH = Math.floor(previewHeight / rows)
  // Crop preview to exact grid area (discard remainder pixels)
  const cropWidth = cellW * cols
  const cropHeight = cellH * rows

  const strokeWidth = 2
  const lines = []

  // Vertical lines (at floor-based cell boundaries)
  for (let c = 1; c < cols; c++) {
    const x = c * cellW
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${cropHeight}" stroke="white" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-opacity="0.85"/>`)
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${cropHeight}" stroke="black" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-dashoffset="8" stroke-opacity="0.4"/>`)
  }

  // Horizontal lines (at floor-based cell boundaries)
  for (let r = 1; r < rows; r++) {
    const y = r * cellH
    lines.push(`<line x1="0" y1="${y}" x2="${cropWidth}" y2="${y}" stroke="white" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-opacity="0.85"/>`)
    lines.push(`<line x1="0" y1="${y}" x2="${cropWidth}" y2="${y}" stroke="black" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-dashoffset="8" stroke-opacity="0.4"/>`)
  }

  // Grid size label in center
  const label = `${rows}×${cols}`
  const fontSize = Math.max(24, Math.round(previewWidth / 10))
  lines.push(`<rect x="${previewWidth / 2 - fontSize * 1.5}" y="${previewHeight / 2 - fontSize * 0.7}" width="${fontSize * 3}" height="${fontSize * 1.4}" rx="8" fill="rgba(0,0,0,0.6)"/>`)
  lines.push(`<text x="${previewWidth / 2}" y="${previewHeight / 2 + fontSize * 0.3}" text-anchor="middle" font-size="${fontSize}" font-family="Arial,sans-serif" font-weight="bold" fill="white">${label}</text>`)

  const svgOverlay = Buffer.from(
    `<svg width="${cropWidth}" height="${cropHeight}">${lines.join('')}</svg>`
  )

  const result = await image
    .clone()
    .resize(previewWidth, previewHeight, { fit: 'fill' })
    .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .webp({ quality: 80 })
    .toBuffer()

  return result
}

module.exports = { generatePreview }
```

- [ ] **Step 2: Manual test — generate preview and save to disk**

Run: `cd /Users/ly/dev/fStikBot && node -e "
const sharp = require('sharp');
const { generatePreview } = require('./utils/mosaic-preview');
// Create a test image 600x400
sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 100, g: 150, b: 200 } } })
  .jpeg().toBuffer()
  .then(buf => generatePreview(buf, 3, 4))
  .then(result => { require('fs').writeFileSync('/tmp/mosaic-preview-test.webp', result); console.log('Preview saved to /tmp/mosaic-preview-test.webp, size:', result.length); })
  .catch(err => console.error(err))
"`

Expected: File created at `/tmp/mosaic-preview-test.webp`, viewable, shows a 3×4 grid overlay.

- [ ] **Step 3: Commit**

```bash
git add utils/mosaic-preview.js
git commit -m "feat(mosaic): add preview generation with grid overlay"
```

---

### Task 3: Image Splitting (`utils/mosaic-split.js`)

**Files:**
- Create: `utils/mosaic-split.js`

**Depends on:** Nothing (standalone Sharp utility)

- [ ] **Step 1: Create `utils/mosaic-split.js`**

```javascript
const sharp = require('sharp')

const splitImage = async (imageBuffer, rows, cols) => {
  const image = sharp(imageBuffer, {
    failOnError: false,
    limitInputPixels: false
  })

  const metadata = await image.metadata()
  const cellWidth = Math.floor(metadata.width / cols)
  const cellHeight = Math.floor(metadata.height / rows)

  const cells = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = await image
        .clone()
        .extract({
          left: c * cellWidth,
          top: r * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .resize(100, 100, { fit: 'fill' })
        .webp({ quality: 90 })
        .toBuffer()

      cells.push(cell)
    }
  }

  return cells
}

const checkMinCellSize = (width, height, rows, cols) => {
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)
  return cellWidth >= 80 && cellHeight >= 80
}

module.exports = { splitImage, checkMinCellSize }
```

- [ ] **Step 2: Manual test — split a test image**

Run: `cd /Users/ly/dev/fStikBot && node -e "
const sharp = require('sharp');
const { splitImage, checkMinCellSize } = require('./utils/mosaic-split');
sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 100, g: 150, b: 200 } } })
  .jpeg().toBuffer()
  .then(buf => splitImage(buf, 3, 4))
  .then(cells => {
    console.log('Cells count:', cells.length);
    console.log('First cell size:', cells[0].length, 'bytes');
    return sharp(cells[0]).metadata();
  })
  .then(meta => console.log('Cell dimensions:', meta.width, 'x', meta.height, meta.format))
  .catch(err => console.error(err));
console.log('Min cell check 600x400 3x4:', checkMinCellSize(600, 400, 3, 4));
console.log('Min cell check 150x200 3x4:', checkMinCellSize(150, 200, 3, 4));
"`

Expected:
- 12 cells (3×4)
- Each cell: 100×100 webp
- `checkMinCellSize(600,400,3,4)` → true (150×133)
- `checkMinCellSize(150,200,3,4)` → false (37×66)

- [ ] **Step 3: Commit**

```bash
git add utils/mosaic-split.js
git commit -m "feat(mosaic): add image splitting utility"
```

---

### Task 4: Locale Strings

**Files:**
- Modify: `locales/en.yaml`
- Modify: `locales/uk.yaml`

**Depends on:** Nothing

- [ ] **Step 1: Add English locale strings to `locales/en.yaml`**

Add at the end of the file:

```yaml
  mosaic:
    enter: |
      🔲 Mosaic mode for <b>${packTitle}</b>

      Send a photo to split into custom emoji grid.
    no_pack: |
      You need a custom emoji pack first.
      Use /new to create one and select "Custom Emoji" type.
    choose_grid: |
      📐 Choose grid size:
    btn:
      recommended: "✅ ${rows}×${cols}"
      option: "${rows}×${cols} · ${total}pcs"
      custom: "✏️ Custom size"
      cancel: "❌ Cancel"
      exit: "🚪 Exit mosaic"
      undo: "🗑 Remove this mosaic"
    custom_prompt: |
      Enter grid size (e.g. 3x4):
    custom_invalid: |
      Invalid format. Use e.g. 3x4 (rows from 1 to 10, cols from 1 to 10, max 50 total).
    no_space: |
      Not enough space in pack. ${freeSlots} slots left, but ${total} needed.
      Choose a smaller grid or create a new pack with /new.
    blurry_warning: |
      ⚠️ Source image is small — result may be blurry at this grid size.
    uploading: "⏳ Uploading ${current}/${total}..."
    done: |
      ✅ Mosaic ${rows}×${cols} added to pack!
    done_link: "📦 Use pack"
    undo_done: |
      🗑 Mosaic removed (${count} emoji deleted from pack).
    undo_failed: |
      ❌ Could not remove some emoji. Try deleting manually.
    wait_photo: |
      Send another photo or tap Exit.
```

- [ ] **Step 2: Add Ukrainian locale strings to `locales/uk.yaml`**

Add at the end of the file:

```yaml
  mosaic:
    enter: |
      🔲 Режим мозаїки для <b>${packTitle}</b>

      Надішліть фото для розрізання на сітку емодзі.
    no_pack: |
      Спочатку потрібен пак кастомних емодзі.
      Використайте /new і оберіть тип "Custom Emoji".
    choose_grid: |
      📐 Оберіть розмір сітки:
    btn:
      recommended: "✅ ${rows}×${cols}"
      option: "${rows}×${cols} · ${total}шт"
      custom: "✏️ Свій розмір"
      cancel: "❌ Скасувати"
      exit: "🚪 Вийти з мозаїки"
      undo: "🗑 Видалити цю мозаїку"
    custom_prompt: |
      Введіть розмір сітки (напр. 3x4):
    custom_invalid: |
      Невірний формат. Наприклад 3x4 (рядки від 1 до 10, стовпці від 1 до 10, макс 50 всього).
    no_space: |
      Недостатньо місця в паку. Вільно ${freeSlots} слотів, потрібно ${total}.
      Оберіть меншу сітку або створіть новий пак через /new.
    blurry_warning: |
      ⚠️ Зображення замале — результат може бути розмитим при цьому розмірі сітки.
    uploading: "⏳ Завантаження ${current}/${total}..."
    done: |
      ✅ Мозаїка ${rows}×${cols} додана в пак!
    done_link: "📦 Використати пак"
    undo_done: |
      🗑 Мозаїку видалено (${count} емодзі видалено з пака).
    undo_failed: |
      ❌ Не вдалося видалити деякі емодзі. Спробуйте вручну.
    wait_photo: |
      Надішліть інше фото або натисніть Вийти.
```

- [ ] **Step 3: Commit**

```bash
git add locales/en.yaml locales/uk.yaml
git commit -m "feat(mosaic): add en/uk locale strings"
```

---

### Task 5: Mosaic Scene (`scenes/mosaic.js`)

**Files:**
- Create: `scenes/mosaic.js`

**Depends on:** Tasks 1-4

This is the core file. It wires together grid suggestions, preview, splitting, upload, and mosaic message.

- [ ] **Step 1: Create `scenes/mosaic.js` — scene setup and enter handler**

```javascript
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { getGridSuggestions } = require('../utils/mosaic-grid')
const { generatePreview } = require('../utils/mosaic-preview')
const { splitImage, checkMinCellSize } = require('../utils/mosaic-split')

const https = require('https')

const mosaic = new Scene('mosaic')

// Helper: download file buffer from Telegram
const downloadFile = (fileUrl, timeout = 30000) => new Promise((resolve, reject) => {
  const data = []
  let totalSize = 0
  const MAX_SIZE = 20 * 1024 * 1024

  const req = https.get(fileUrl, (response) => {
    if (response.statusCode !== 200) {
      req.destroy()
      reject(new Error(`Download failed: ${response.statusCode}`))
      return
    }
    response.on('data', (chunk) => {
      totalSize += chunk.length
      if (totalSize > MAX_SIZE) {
        req.destroy()
        reject(new Error('File too large'))
        return
      }
      data.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(data)))
  })
  req.on('error', reject)
  req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')) })
})

// Helper: build inline keyboard for grid selection
const buildGridKeyboard = (ctx, suggestions) => {
  const { recommended, alternatives } = suggestions
  const buttons = []

  // Row 1: recommended
  buttons.push([
    Markup.callbackButton(
      ctx.i18n.t('cmd.mosaic.btn.recommended', { rows: recommended.rows, cols: recommended.cols }),
      `mosaic:grid:${recommended.rows}:${recommended.cols}`
    )
  ])

  // Row 2: alternatives
  if (alternatives.length > 0) {
    buttons.push(alternatives.map(alt =>
      Markup.callbackButton(
        ctx.i18n.t('cmd.mosaic.btn.option', { rows: alt.rows, cols: alt.cols, total: alt.total }),
        `mosaic:grid:${alt.rows}:${alt.cols}`
      )
    ))
  }

  // Row 3: custom + cancel
  buttons.push([
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.custom'), 'mosaic:custom'),
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.cancel'), 'mosaic:cancel')
  ])

  // Row 4: exit
  buttons.push([
    Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.exit'), 'mosaic:exit')
  ])

  return Markup.inlineKeyboard(buttons)
}

mosaic.enter(async (ctx) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  ctx.session.scene.mosaic = {}

  // Check if user has a custom_emoji pack selected
  const userInfo = ctx.session.userInfo
  if (!userInfo || !userInfo.stickerSet) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_pack'))
    return ctx.scene.leave()
  }

  const stickerSet = await ctx.db.StickerSet.findById(userInfo.stickerSet)
  if (!stickerSet || stickerSet.packType !== 'custom_emoji') {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_pack'))
    return ctx.scene.leave()
  }

  ctx.session.scene.mosaic.packId = stickerSet.id
  ctx.session.scene.mosaic.packName = stickerSet.name

  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.enter', {
    packTitle: stickerSet.title
  }), {
    reply_markup: Markup.keyboard([
      [{ text: ctx.i18n.t('cmd.mosaic.btn.exit') }]
    ]).resize()
  })
})

module.exports = mosaic
```

- [ ] **Step 2: Add photo handler — generate preview and show grid options**

Append to `scenes/mosaic.js` before `module.exports`:

```javascript
mosaic.on('photo', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  // Block new photos while uploading
  if (ctx.session.scene.mosaic.uploading) {
    return ctx.replyWithHTML('⏳ Please wait, upload in progress...')
  }

  const photo = ctx.message.photo
  const largest = photo[photo.length - 1]

  // Download the photo
  const fileUrl = await ctx.telegram.getFileLink(largest.file_id)
  const imageBuffer = await downloadFile(fileUrl.href || fileUrl)

  const width = largest.width
  const height = largest.height

  // Count existing stickers in pack
  const stickerSet = await ctx.db.StickerSet.findById(ctx.session.scene.mosaic.packId)
  const currentCount = await ctx.db.Sticker.countDocuments({
    stickerSet: stickerSet.id,
    deleted: false
  })
  const freeSlots = 200 - currentCount

  const suggestions = getGridSuggestions(width, height, freeSlots)

  if (suggestions.type === 'no_space') {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_space', { freeSlots, total: 4 }))
    return
  }

  // Store in scene state
  ctx.session.scene.mosaic.photoFileId = largest.file_id
  ctx.session.scene.mosaic.photoWidth = width
  ctx.session.scene.mosaic.photoHeight = height
  ctx.session.scene.mosaic.imageBuffer = null // Don't store buffer in session
  ctx.session.scene.mosaic.freeSlots = freeSlots

  // Generate preview with recommended grid
  const { recommended } = suggestions
  const previewBuffer = await generatePreview(imageBuffer, recommended.rows, recommended.cols)

  // Check for blurry warning
  const isBlurry = !checkMinCellSize(width, height, recommended.rows, recommended.cols)
  const blurryText = isBlurry ? '\n' + ctx.i18n.t('cmd.mosaic.blurry_warning') : ''

  const msg = await ctx.replyWithPhoto(
    { source: previewBuffer },
    {
      caption: ctx.i18n.t('cmd.mosaic.choose_grid') + blurryText,
      parse_mode: 'HTML',
      reply_markup: buildGridKeyboard(ctx, suggestions)
    }
  )

  ctx.session.scene.mosaic.previewMessageId = msg.message_id
})
```

- [ ] **Step 3: Add grid selection callback — split, upload, send mosaic**

Append to `scenes/mosaic.js` before `module.exports`:

```javascript
mosaic.action(/^mosaic:grid:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  const rows = parseInt(ctx.match[1])
  const cols = parseInt(ctx.match[2])
  const total = rows * cols
  const state = ctx.session.scene.mosaic

  await ctx.answerCbQuery()

  // Validate space
  if (total > state.freeSlots) {
    return ctx.answerCbQuery(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }), true)
  }

  // Download photo again (not stored in session)
  const fileUrl = await ctx.telegram.getFileLink(state.photoFileId)
  const imageBuffer = await downloadFile(fileUrl.href || fileUrl)

  // Check min cell size
  const isBlurry = !checkMinCellSize(state.photoWidth, state.photoHeight, rows, cols)

  // Send progress message
  const progressMsg = await ctx.replyWithHTML(
    ctx.i18n.t('cmd.mosaic.uploading', { current: 0, total })
  )

  // Split image
  const cells = await splitImage(imageBuffer, rows, cols)

  // Upload all cells to the pack
  const stickerSet = await ctx.db.StickerSet.findById(state.packId)
  const uploadedIds = []
  const uploadedFileIds = []

  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / cols) + 1
    const c = (i % cols) + 1

    // Upload sticker file
    const uploaded = await ctx.telegram.callApi('uploadStickerFile', {
      user_id: ctx.from.id,
      sticker_format: 'static',
      sticker: { source: cells[i] }
    })

    // Add to set
    await ctx.telegram.callApi('addStickerToSet', {
      user_id: ctx.from.id,
      name: stickerSet.name,
      sticker: {
        sticker: uploaded.file_id,
        format: 'static',
        emoji_list: ['🔲'],
        keywords: ['mosaic', `r${r}c${c}`]
      }
    })

    // Get the sticker info to find custom_emoji_id
    const setInfo = await ctx.telegram.callApi('getStickerSet', { name: stickerSet.name })
    const lastSticker = setInfo.stickers[setInfo.stickers.length - 1]
    uploadedIds.push(lastSticker.custom_emoji_id)
    uploadedFileIds.push(lastSticker.file_id)

    // Save sticker to DB
    await ctx.db.Sticker.addSticker(stickerSet.id, '🔲', {
      file_id: lastSticker.file_id,
      file_unique_id: lastSticker.file_unique_id,
      stickerType: 'custom_emoji'
    })

    // Update progress every 3 uploads
    if ((i + 1) % 3 === 0 || i === cells.length - 1) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        null,
        ctx.i18n.t('cmd.mosaic.uploading', { current: i + 1, total })
      ).catch(() => {})
      await ctx.telegram.callApi('sendChatAction', {
        chat_id: ctx.chat.id,
        action: 'upload_document'
      }).catch(() => {})
    }
  }

  // Delete progress message
  await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {})

  // Build mosaic message with custom_emoji entities
  const placeholder = '\u2B1C' // ⬜ white square as placeholder
  let text = ''
  const entities = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      const offset = text.length
      text += placeholder
      entities.push({
        type: 'custom_emoji',
        offset,
        length: placeholder.length,
        custom_emoji_id: uploadedIds[idx]
      })
    }
    if (r < rows - 1) text += '\n'
  }

  // Add pack link
  const packLink = `${ctx.config.emojiLinkPrefix}${stickerSet.name}`
  text += '\n\n'
  const linkOffset = text.length
  text += ctx.i18n.t('cmd.mosaic.done', { rows, cols })

  await ctx.telegram.callApi('sendMessage', {
    chat_id: ctx.chat.id,
    text,
    entities,
    reply_markup: Markup.inlineKeyboard([
      [Markup.urlButton(ctx.i18n.t('cmd.mosaic.done_link'), packLink)],
      [Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.undo'), 'mosaic:undo')]
    ])
  })

  // Store uploaded file IDs for undo
  state.lastMosaicIds = uploadedFileIds
  state.lastMosaicCount = total

  // Ready for next photo
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
})
```

- [ ] **Step 4: Add custom size handler**

Append to `scenes/mosaic.js` before `module.exports`:

```javascript
mosaic.action('mosaic:custom', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()
  ctx.session.scene.mosaic.waitingCustom = true
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_prompt'))
})

mosaic.on('text', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  // Only handle text if waiting for custom input
  if (!ctx.session.scene.mosaic.waitingCustom) return

  const text = ctx.message.text.trim()

  // Flexible parsing: 3x4, 3×4, 3*4, 3:4, 3 на 4
  const match = text.match(/^(\d+)\s*[x×*:]\s*(\d+)$/i) ||
                text.match(/^(\d+)\s+(?:на|by|on)\s+(\d+)$/i)

  if (!match) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const rows = parseInt(match[1])
  const cols = parseInt(match[2])
  const total = rows * cols

  if (rows < 1 || rows > 10 || cols < 1 || cols > 10 || total > 50) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const state = ctx.session.scene.mosaic
  if (total > state.freeSlots) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }))
  }

  state.waitingCustom = false

  // Trigger the same logic as grid callback
  // Simulate the action by calling the handler logic directly
  ctx.match = [null, String(rows), String(cols)]
  return mosaic.middleware()[0]  // This won't work — we need a different approach
})
```

Actually, extract the split-upload-send logic into a shared function. **Revise Step 3 and Step 4:**

Replace the grid action handler and custom text handler with a shared `processMosaic` function. The full revised code for steps 3+4:

```javascript
// Retry helper with exponential backoff
const retry = async (fn, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === maxRetries) throw err
      const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

// Colored square fallbacks for variety in emoji search
const FALLBACK_EMOJI = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜', '🔲']

// Shared function: split, upload, send mosaic
const processMosaic = async (ctx, rows, cols) => {
  const state = ctx.session.scene.mosaic
  const total = rows * cols

  // Lock: prevent concurrent processing
  if (state.uploading) {
    await ctx.replyWithHTML('⏳ Please wait, upload in progress...')
    return
  }
  state.uploading = true

  try {
    // Download photo again
    const fileUrl = await ctx.telegram.getFileLink(state.photoFileId)
    const imageBuffer = await downloadFile(fileUrl.href || fileUrl)

    // Send progress message
    const progressMsg = await ctx.replyWithHTML(
      ctx.i18n.t('cmd.mosaic.uploading', { current: 0, total })
    )

    // Split image
    const cells = await splitImage(imageBuffer, rows, cols)

    // Upload all cells to the pack
    const stickerSet = await ctx.db.StickerSet.findById(state.packId)
    const uploadedIds = []
    const uploadedFileIds = []

    for (let i = 0; i < cells.length; i++) {
      const r = Math.floor(i / cols) + 1
      const c = (i % cols) + 1
      const fallbackEmoji = FALLBACK_EMOJI[i % FALLBACK_EMOJI.length]

      try {
        const uploaded = await retry(() =>
          ctx.telegram.callApi('uploadStickerFile', {
            user_id: ctx.from.id,
            sticker_format: 'static',
            sticker: { source: cells[i] }
          })
        )

        await retry(() =>
          ctx.telegram.callApi('addStickerToSet', {
            user_id: ctx.from.id,
            name: stickerSet.name,
            sticker: {
              sticker: uploaded.file_id,
              format: 'static',
              emoji_list: [fallbackEmoji],
              keywords: ['mosaic', `r${r}c${c}`]
            }
          })
        )

        const setInfo = await ctx.telegram.callApi('getStickerSet', { name: stickerSet.name })
        const lastSticker = setInfo.stickers[setInfo.stickers.length - 1]
        uploadedIds.push(lastSticker.custom_emoji_id)
        uploadedFileIds.push(lastSticker.file_id)

        await ctx.db.Sticker.addSticker(stickerSet.id, fallbackEmoji, {
          file_id: lastSticker.file_id,
          file_unique_id: lastSticker.file_unique_id,
          stickerType: 'custom_emoji'
        })
      } catch (err) {
        // Upload failed after retries — rollback all uploaded stickers
        for (const fileId of uploadedFileIds) {
          await ctx.telegram.callApi('deleteStickerFromSet', { sticker: fileId }).catch(() => {})
          await ctx.db.Sticker.updateOne(
            { fileId, stickerSet: stickerSet.id },
            { $set: { deleted: true, deletedAt: new Date() } }
          ).catch(() => {})
        }
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {})
        await ctx.replyWithHTML(`❌ Upload failed at piece ${i + 1}/${total}. All uploaded pieces rolled back. Try again.`)
        return
      }

      if ((i + 1) % 3 === 0 || i === cells.length - 1) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, progressMsg.message_id, null,
          ctx.i18n.t('cmd.mosaic.uploading', { current: i + 1, total })
        ).catch(() => {})
        await ctx.telegram.callApi('sendChatAction', {
          chat_id: ctx.chat.id, action: 'choose_sticker'
        }).catch(() => {})
      }
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {})

  // Build mosaic message
  const placeholder = '\u2B1C'
  let text = ''
  const entities = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      const offset = text.length
      text += placeholder
      entities.push({
        type: 'custom_emoji',
        offset,
        length: placeholder.length,
        custom_emoji_id: uploadedIds[idx]
      })
    }
    if (r < rows - 1) text += '\n'
  }

  const packLink = `${ctx.config.emojiLinkPrefix}${stickerSet.name}`
  text += '\n\n' + ctx.i18n.t('cmd.mosaic.done', { rows, cols })

  await ctx.telegram.callApi('sendMessage', {
    chat_id: ctx.chat.id,
    text,
    entities,
    reply_markup: Markup.inlineKeyboard([
      [Markup.urlButton(ctx.i18n.t('cmd.mosaic.done_link'), packLink)],
      [Markup.callbackButton(ctx.i18n.t('cmd.mosaic.btn.undo'), 'mosaic:undo')]
    ])
  })

  state.lastMosaicIds = uploadedFileIds
  state.lastMosaicCount = total
  state.waitingCustom = false

  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
  } finally {
    state.uploading = false
  }
}

// Grid selection callback
mosaic.action(/^mosaic:grid:(\d+):(\d+)$/, async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()

  const rows = parseInt(ctx.match[1])
  const cols = parseInt(ctx.match[2])
  const total = rows * cols
  const state = ctx.session.scene.mosaic

  if (total > state.freeSlots) {
    return ctx.answerCbQuery(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }), true)
  }

  return processMosaic(ctx, rows, cols)
})

// Custom size: prompt
mosaic.action('mosaic:custom', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()
  ctx.session.scene.mosaic.waitingCustom = true
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_prompt'))
})

// Custom size: parse text input
mosaic.on('text', async (ctx) => {
  if (!ctx.session.scene?.mosaic?.waitingCustom) return

  const text = ctx.message.text.trim()
  const match = text.match(/^(\d+)\s*[x×*:]\s*(\d+)$/i) ||
                text.match(/^(\d+)\s+(?:на|by|on)\s+(\d+)$/i)

  if (!match) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const rows = parseInt(match[1])
  const cols = parseInt(match[2])
  const total = rows * cols

  if (rows < 1 || rows > 10 || cols < 1 || cols > 10 || total > 50) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.custom_invalid'))
  }

  const state = ctx.session.scene.mosaic
  if (total > state.freeSlots) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.no_space', {
      freeSlots: state.freeSlots, total
    }))
  }

  return processMosaic(ctx, rows, cols)
})
```

- [ ] **Step 5: Add cancel, undo, and exit handlers**

Append to `scenes/mosaic.js` before `module.exports`:

```javascript
// Cancel current photo
mosaic.action('mosaic:cancel', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()
  ctx.session.scene.mosaic.photoFileId = null
  ctx.session.scene.mosaic.waitingCustom = false
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.wait_photo'))
})

// Undo: remove last mosaic from pack
mosaic.action('mosaic:undo', async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  await ctx.answerCbQuery()

  const state = ctx.session.scene.mosaic
  if (!state.lastMosaicIds || state.lastMosaicIds.length === 0) {
    return ctx.answerCbQuery('Nothing to undo', true)
  }

  let deleted = 0
  for (const fileId of state.lastMosaicIds) {
    try {
      await ctx.telegram.callApi('deleteStickerFromSet', { sticker: fileId })
      await ctx.db.Sticker.updateOne(
        { fileId, stickerSet: state.packId },
        { $set: { deleted: true, deletedAt: new Date() } }
      )
      deleted++
    } catch (e) {
      // Sticker may already be deleted
    }
  }

  state.lastMosaicIds = []

  if (deleted > 0) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.undo_done', { count: deleted }))
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.undo_failed'))
  }
})

// Exit scene
mosaic.action('mosaic:exit', async (ctx) => {
  await ctx.answerCbQuery()
  delete ctx.session.scene.mosaic
  await ctx.scene.leave()
})

mosaic.hears(/🚪/, async (ctx) => {
  delete ctx.session.scene.mosaic
  await ctx.scene.leave()
})
```

- [ ] **Step 6: Test scene loads without errors**

Run: `cd /Users/ly/dev/fStikBot && node -e "const mosaic = require('./scenes/mosaic'); console.log('Scene name:', mosaic.id); console.log('Type:', typeof mosaic.middleware)"`

Expected: `Scene name: mosaic`, `Type: function`

- [ ] **Step 7: Commit**

```bash
git add scenes/mosaic.js
git commit -m "feat(mosaic): add mosaic scene with full split/upload/preview flow"
```

---

### Task 6: Register Scene and Command

**Files:**
- Modify: `scenes/index.js:1-85`
- Modify: `bot.js` (command registration section)

**Depends on:** Task 5

- [ ] **Step 1: Register mosaic scene in `scenes/index.js`**

Add import after line 23 (`const donate = require('./donate')`):

```javascript
const mosaic = require('./mosaic')
```

Add `mosaic` to the Stage array (after `donate` on line 39):

```javascript
const stage = new Stage([].concat(
  sceneNewPack,
  originalSticker,
  deleteSticker,
  messaging,
  packEdit,
  adminPackBulkDelete,
  searchStickerSet,
  photoClear,
  videoRound,
  packCatalog,
  packFrame,
  packRename,
  packDelete,
  packAbout,
  donate,
  mosaic
))
```

Add `/mosaic` to the command passthrough list (line 66-82):

```javascript
stage.hears(([
  '/start',
  '/help',
  '/packs',
  '/emoji',
  '/lang',
  '/donate',
  '/publish',
  '/delete',
  '/frame',
  '/rename',
  '/catalog',
  '/mosaic'
]), async (ctx, next) => {
```

- [ ] **Step 2: Add /mosaic command in `bot.js`**

Find the section where scene entry commands are defined (near `privateMessage.hears(/\/new/`). Add:

```javascript
privateMessage.command('mosaic', (ctx) => ctx.scene.enter('mosaic'))
```

- [ ] **Step 3: Verify bot starts without errors**

Run: `cd /Users/ly/dev/fStikBot && timeout 5 node -e "require('./bot')" 2>&1 || true`

Expected: No immediate crash errors (may timeout waiting for DB, that's ok).

- [ ] **Step 4: Commit**

```bash
git add scenes/index.js bot.js
git commit -m "feat(mosaic): register scene and /mosaic command"
```

---

### Task 7: Add Mosaic Button to Pack Menu

**Files:**
- Modify: `handlers/packs.js:176-196`

**Depends on:** Task 6

- [ ] **Step 1: Add mosaic button for custom_emoji packs in `handlers/packs.js`**

Find the inline keyboard section (around line 176-195). Add a mosaic button row conditionally for custom_emoji packs. Insert after the frame button row (line 187-188):

```javascript
// Existing:
[
  Markup.callbackButton(ctx.i18n.t('callback.pack.btn.frame'), 'set_frame')
],
// Add this:
...(stickerSet.packType === 'custom_emoji' ? [[
  Markup.callbackButton('🔲 ' + ctx.i18n.t('callback.pack.btn.mosaic'), 'mosaic:enter')
]] : []),
```

- [ ] **Step 2: Add callback handler for mosaic:enter in `bot.js` or `handlers/packs.js`**

Add callback action handler (wherever other pack-related actions are handled):

```javascript
bot.action('mosaic:enter', (ctx) => {
  ctx.answerCbQuery()
  return ctx.scene.enter('mosaic')
})
```

- [ ] **Step 3: Add locale string for the button**

In `locales/en.yaml`, add under `callback.pack.btn`:

```yaml
      mosaic: Mosaic
```

In `locales/uk.yaml`, add under `callback.pack.btn`:

```yaml
      mosaic: Мозаїка
```

- [ ] **Step 4: Commit**

```bash
git add handlers/packs.js bot.js locales/en.yaml locales/uk.yaml
git commit -m "feat(mosaic): add mosaic button to pack menu for custom_emoji packs"
```

---

### Task 8: End-to-End Testing

**Files:** None (manual testing)

**Depends on:** Tasks 1-7

- [ ] **Step 1: Verify bot starts**

Run: `cd /Users/ly/dev/fStikBot && node index.js`

Check: No startup errors.

- [ ] **Step 2: Test /mosaic command**

In Telegram:
1. Ensure you have a custom_emoji pack selected
2. Send `/mosaic`
3. Expected: Bot replies with "Mosaic mode for {pack}. Send a photo."

- [ ] **Step 3: Test photo → preview → grid selection**

1. Send a landscape photo
2. Expected: Bot replies with preview image (photo with grid overlay) + inline buttons
3. Tap recommended grid button
4. Expected: Progress messages → mosaic message with custom emoji → pack link + undo button

- [ ] **Step 4: Test undo**

1. Tap "Remove this mosaic" button
2. Expected: Bot confirms deletion with count

- [ ] **Step 5: Test custom size**

1. Send another photo
2. Tap "Custom size"
3. Type "2x3"
4. Expected: Mosaic created with 2×3 grid

- [ ] **Step 6: Test edge cases**

1. Send a very wide panorama image → should get strip suggestions (1×N)
2. Send a small image (< 300px) → should see blurry warning
3. Type invalid custom size (e.g. "abc") → should see error message
4. Test exit button → should leave scene

- [ ] **Step 7: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(mosaic): fixes from e2e testing"
```
