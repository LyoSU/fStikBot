# Mosaic Input Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the mosaic scene to accept image documents (JPEG/PNG/WebP) and static stickers in addition to photos, with clear rejection messages for animated/video inputs.

**Architecture:** Add a pure `getMosaicSource(message)` helper to `scenes/mosaic.js` that normalizes any accepted message type into `{ fileId, width, height }` or returns an i18n error key. The existing `mosaic.on('photo', ...)` handler is widened to `['photo', 'document', 'sticker']` and delegates to the helper. A second lightweight handler for `['animation', 'video', 'video_note']` replies with a rejection. Processing pipeline (sharp, grid, upload) is untouched.

**Tech Stack:** Telegraf v3 scenes, Sharp (image processing), existing `utils/mosaic-*` modules.

**Spec:** `docs/superpowers/specs/2026-04-15-mosaic-input-types-design.md`

**Testing approach:** Manual smoke test only — consistent with existing mosaic code (no unit/integration tests exist for the scene today). Adding a test harness for this small extension is out of scope.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `locales/uk.yaml` | Modify (lines 318–353 region) | Add 3 keys under `cmd.mosaic`: `reject_animated`, `reject_document`, `reject_media` |
| `locales/en.yaml` | Modify (lines 325–360 region) | Same 3 keys in English |
| `scenes/mosaic.js` | Modify | Add `getMosaicSource` helper; replace `mosaic.on('photo', ...)` with multi-type handler; add animation/video reject handler |

**Naming note:** The scene stores `photoFileId`, `photoWidth`, `photoHeight` in session state (`scenes/mosaic.js:144-146, 180, 189, 336, 362`). These names become slightly misleading (sources can now be documents or stickers too), but they functionally describe "the file_id of the image we will mosaic". Do **not** rename — it's 6 sites of churn for zero behavioural benefit.

---

### Task 1: Add i18n keys for rejection messages

**Files:**
- Modify: `locales/uk.yaml` (after line 353, before `donate:` on line 354)
- Modify: `locales/en.yaml` (after line 360, before `donate:` on line 361)

This task is independent and safe to land alone. The keys have no runtime effect until Task 3 uses them.

- [ ] **Step 1: Add 3 keys to `locales/uk.yaml`**

Find the line `    wait_photo: |` (line 352) followed by its body `      Надішліть інше фото або натисніть Вийти.` (line 353). Insert immediately after, at the same indentation as other `cmd.mosaic.*` keys (4 spaces):

```yaml
    reject_animated: |
      Анімовані/відео стікери поки не підтримую. Надішліть статичний стікер, фото або PNG/JPEG/WebP файлом.
    reject_document: |
      Підтримую тільки зображення (JPEG/PNG/WebP). Надішліть файл у цьому форматі.
    reject_media: |
      Анімації та відео поки не підтримую. Надішліть статичний стікер, фото або PNG/JPEG/WebP файлом.
```

- [ ] **Step 2: Add 3 keys to `locales/en.yaml`**

Find the line `    wait_photo: |` (line 359) followed by its body `      Send another photo or tap Exit.` (line 360). Insert immediately after, at the same indentation:

```yaml
    reject_animated: |
      Animated/video stickers aren't supported yet. Send a static sticker, a photo, or a PNG/JPEG/WebP file.
    reject_document: |
      Only images are supported (JPEG/PNG/WebP). Please send a file in one of these formats.
    reject_media: |
      Animations and videos aren't supported yet. Send a static sticker, a photo, or a PNG/JPEG/WebP file.
```

- [ ] **Step 3: Verify YAML parses**

Run:
```bash
node -e "require('js-yaml').load(require('fs').readFileSync('locales/uk.yaml','utf8')); require('js-yaml').load(require('fs').readFileSync('locales/en.yaml','utf8')); console.log('ok')"
```

Expected output: `ok`

If it errors, the most likely cause is indentation — all `cmd.mosaic.*` keys must be at 4 spaces of indent, with the body block at 6 spaces.

- [ ] **Step 4: Commit**

```bash
git add locales/uk.yaml locales/en.yaml
git commit -m "i18n(mosaic): add rejection messages for unsupported input types"
```

---

### Task 2: Add `getMosaicSource` helper

**Files:**
- Modify: `scenes/mosaic.js` (add helper above line 108 where `// --- Photo handler ---` comment is)

Pure function. Does not download anything — only reads fields from `message` and returns a normalized shape or an i18n key. Kept inline (not extracted to `utils/`) per spec decision (YAGNI).

- [ ] **Step 1: Insert the helper**

Find line 107 in `scenes/mosaic.js` (blank line before `// --- Photo handler ---`). Insert the following **above** the `// --- Photo handler ---` comment:

```javascript
// Normalize any accepted message into { fileId, width, height } or { error: <i18n-key> }.
// For documents, width/height come from the optional thumb — may be null, caller reads from buffer.
const IMAGE_DOCUMENT_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const getMosaicSource = (message) => {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]
    return { fileId: largest.file_id, width: largest.width, height: largest.height }
  }

  if (message.sticker) {
    if (message.sticker.is_animated || message.sticker.is_video) {
      return { error: 'cmd.mosaic.reject_animated' }
    }
    return {
      fileId: message.sticker.file_id,
      width: message.sticker.width,
      height: message.sticker.height
    }
  }

  if (message.document) {
    const mime = message.document.mime_type
    if (!mime || !IMAGE_DOCUMENT_MIMES.has(mime)) {
      return { error: 'cmd.mosaic.reject_document' }
    }
    return {
      fileId: message.document.file_id,
      width: message.document.thumb ? message.document.thumb.width : null,
      height: message.document.thumb ? message.document.thumb.height : null
    }
  }

  // Should not be reachable — handler only binds to photo/document/sticker.
  return { error: 'cmd.mosaic.reject_media' }
}

```

- [ ] **Step 2: Syntax check**

Run:
```bash
node -c scenes/mosaic.js
```

Expected: no output (silent success). If there's a syntax error, fix indentation/brackets before proceeding.

- [ ] **Step 3: Commit**

```bash
git add scenes/mosaic.js
git commit -m "feat(mosaic): add getMosaicSource helper to normalize input types"
```

---

### Task 3: Rewire handler to accept photo, document, and sticker

**Files:**
- Modify: `scenes/mosaic.js:108-167` (the `mosaic.on('photo', ...)` block)

The full existing handler is replaced. Behaviour changes: (a) binds to three message types, (b) pulls source via `getMosaicSource`, (c) short-circuits with a reply on error, (d) reads width/height from sharp metadata when the message doesn't provide them (image documents).

- [ ] **Step 1: Add sharp require**

Sharp is not directly imported in `scenes/mosaic.js` today — it's used only indirectly via `utils/mosaic-*`. We need it here for the image-document dimension fallback.

Add this line directly after the existing `const https = require('https')` line (currently line 6):

```javascript
const sharp = require('sharp')
```

- [ ] **Step 2: Replace the photo handler**

Locate the block starting at `mosaic.on('photo', async (ctx) => {` (line 110) through its closing `})` (line 167 — the line that closes right after `ctx.session.scene.mosaic.previewMessageId = msg.message_id`).

Replace the **entire block** (lines 110–167) with:

```javascript
mosaic.on(['photo', 'document', 'sticker'], async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()

  // Block new input while uploading
  if (ctx.session.scene.mosaic.uploading) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.uploading', { current: '...', total: '...' }))
  }

  const source = getMosaicSource(ctx.message)
  if (source.error) {
    return ctx.replyWithHTML(ctx.i18n.t(source.error))
  }

  // Download the source
  const fileUrl = await ctx.telegram.getFileLink(source.fileId)
  const imageBuffer = await downloadFile(fileUrl.href || fileUrl)

  // Documents don't carry width/height on the message itself — read from buffer.
  let { width, height } = source
  if (!width || !height) {
    const meta = await sharp(imageBuffer).metadata()
    width = meta.width
    height = meta.height
  }

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
  ctx.session.scene.mosaic.photoFileId = source.fileId
  ctx.session.scene.mosaic.photoWidth = width
  ctx.session.scene.mosaic.photoHeight = height
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

Key diffs from the original (for reviewers):
- `on('photo'` → `on(['photo', 'document', 'sticker']`
- Removed `const photo = ctx.message.photo; const largest = photo[photo.length - 1]`
- Added `getMosaicSource` call with error short-circuit
- Width/height now taken from `source`, with sharp fallback for docs
- `largest.file_id` → `source.fileId` at the state-storage site

- [ ] **Step 3: Syntax check**

Run:
```bash
node -c scenes/mosaic.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scenes/mosaic.js
git commit -m "feat(mosaic): accept image documents and static stickers as input"
```

---

### Task 4: Reject handler for animations and videos

**Files:**
- Modify: `scenes/mosaic.js` (insert after the block just modified in Task 3)

Separate handler because animation/video/video_note never have a valid mosaic path — we just want a friendly reply, no downloads, no state changes.

- [ ] **Step 1: Insert the reject handler**

After the closing `})` of the multi-type handler (the new end of what used to be line 167), insert:

```javascript

// --- Reject animated/video inputs ---

mosaic.on(['animation', 'video', 'video_note'], async (ctx) => {
  if (!ctx.session.scene?.mosaic) return ctx.scene.leave()
  if (ctx.session.scene.mosaic.uploading) return
  await ctx.replyWithHTML(ctx.i18n.t('cmd.mosaic.reject_media'))
})
```

Placement check: this must come **before** the `// --- Shared processMosaic function ---` comment (previously line 169). The `processMosaic` function is not a handler registration, so order vs. it doesn't matter for Telegraf, but keep the code grouped.

- [ ] **Step 2: Syntax check**

Run:
```bash
node -c scenes/mosaic.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scenes/mosaic.js
git commit -m "feat(mosaic): reject animations, videos, and video notes with a friendly message"
```

---

### Task 5: Manual smoke test

**Files:** none (verification only)

No automated tests exist for the mosaic scene. This checklist must be executed by a human (or agent with Telegram access) against a running bot instance before the feature is considered done.

- [ ] **Step 1: Start the bot in dev mode**

Run:
```bash
npm start
```

(Or whatever the project's dev-run command is — see `package.json` scripts and `README`.)

- [ ] **Step 2: Execute the test matrix**

In Telegram, with a custom-emoji pack selected, enter `/mosaic` and send each of the following inputs one at a time. After each, verify the expected behaviour and then send the next input **without leaving the scene**.

| # | Input | Expected |
|---|---|---|
| 1 | A regular photo (camera icon) | Preview with grid keyboard appears (existing behaviour) |
| 2 | A JPEG file sent via paperclip → "File" | Preview appears, mosaic generates crisply |
| 3 | A PNG file sent as document | Preview appears |
| 4 | A WebP file sent as document | Preview appears |
| 5 | A static sticker from any pack | Preview appears |
| 6 | An animated (.tgs) sticker | Reply: "Анімовані/відео стікери поки не підтримую…". Scene stays open. |
| 7 | A video (.webm) sticker | Same reject as #6. Scene stays open. |
| 8 | A GIF (sent as animation) | Reply: "Анімації та відео поки не підтримую…". Scene stays open. |
| 9 | An MP4 video | Same reject as #8. |
| 10 | A PDF or any non-image document | Reply: "Підтримую тільки зображення (JPEG/PNG/WebP)…". Scene stays open. |
| 11 | After any reject (say #6), send a regular photo | Scene proceeds normally — confirms rejects don't break state |
| 12 | Complete a full mosaic from a PNG document (tap a grid button through to done) | Mosaic appears in chat correctly |

- [ ] **Step 3: Check for visual regressions**

For tests #2, #3, #5, look at the final mosaic message in chat and compare to a photo-source mosaic of the same image:
- Are the emoji aligned? (No orphan newlines.)
- Does the transparency of a WebP sticker source produce acceptable visual output? (Transparent pixels visible through emoji.)

If a cell looks broken, screenshot it and stop. Otherwise proceed.

- [ ] **Step 4: Announce done**

If all 12 rows pass, the feature is complete. Report:
- Which inputs were tested
- Any notable visual quirks observed
- Whether any follow-up tasks emerged (e.g. "WebP stickers with heavy alpha look weird — file for later")

No further commit — the code commits in Tasks 1–4 are the deliverable.

---

## Self-review checklist (for plan author)

- Spec requirements covered: photo ✅, image doc ✅, static sticker ✅, reject animated sticker ✅, reject video sticker ✅, reject doc with non-image MIME ✅, reject animation/video/video_note ✅, i18n keys in uk and en ✅, no pipeline changes ✅, scene stays open after reject ✅
- No placeholders — every step shows the exact code or command
- Type consistency — `getMosaicSource` returns `{ fileId, width, height }` or `{ error }` in every task reference
- File paths and line numbers match what's in the repo at the time of writing
