# Emoji Mosaic Feature — Design Spec

## Overview

Add a "mosaic mode" to fStikBot that splits a photo into a grid of custom emoji pieces. When placed together in a Telegram message, the emoji reassemble into the original image.

## User Flow

```
/mosaic (or button in pack menu)
    → Bot: "Mosaic mode enabled for pack {packName}. Send a photo."
    → (check: does user have a current custom_emoji pack? if not — prompt to create one)

User sends photo
    → Bot analyzes aspect ratio
    → Determines split type:
        • ratio ≥ 2.5  → horizontal strip (1 row × N cols)
        • ratio ≤ 0.4  → vertical strip (N rows × 1 col)
        • otherwise    → grid
    → Sharp generates preview (photo with dashed grid overlay)
    → Sends preview + inline keyboard:

      For grid:
        [✅ Split 3×4]                          ← recommended (highlighted)
        [2×3 · 6pcs] [4×6 · 24pcs] [5×7 · 35pcs]  ← alternatives
        [✏️ Custom size]

      For strip (e.g. panorama 5:1):
        [✅ Split 1×5]
        [1×4] [1×6] [1×8]
        [✏️ Custom size]

    → If not enough space in pack — warn user, suggest smaller grid or new pack

User taps a button
    → Sharp splits photo into parts (each → 100×100 WEBP)
    → Uploads all parts to current custom_emoji pack
    → Sends:
        • Message with mosaic (custom emoji entities in grid with newlines)
        • For strips: emoji in a single line
        • Link to pack (t.me/addemoji/{packName})
    → Scene waits for next photo (loop)

/mosaic or "Exit" button
    → Leave scene
```

## Grid Selection Algorithm

```
Input: width × height of photo

1. Compute ratio = width / height

2. Determine type:
   • ratio ≥ 2.5  → horizontal strip (1 row)
   • ratio ≤ 0.4  → vertical strip (1 column)
   • otherwise    → grid

3. For strips:
   • count = round(ratio) for horizontal, round(1/ratio) for vertical
   • Clamp to 3..10
   • Alternatives: ±1, ±2 from recommended

4. For grids:
   • Find all combinations rows × cols where:
     - rows: 2..10, cols: 2..10
     - rows × cols ≤ 50
     - (cols/rows) close to ratio (proportionality)
   • Sort by how close each cell's aspect ratio is to 1:1
     (square emoji look best)
   • Recommendation = best balance of proportionality and count
   • Alternatives = one smaller, one medium, one larger grid

5. Pack space check:
   • freeSlots = 200 - currentEmojiCount
   • Filter out options where rows × cols > freeSlots
   • If recommendation doesn't fit — pick largest that fits
   • If none fit (freeSlots < 4) — notify user
```

## Image Processing Pipeline (Sharp)

### Preview Generation (before user chooses grid)

1. Load photo via Sharp
2. Resize to max 512px on longest side
3. Draw dashed grid lines via SVG overlay composite
4. Output as WEBP → send as photo message

### Splitting (after user chooses grid)

1. Load original at full resolution
2. **Min cell size check**: if `width/cols < 80` or `height/rows < 80` — warn user
   that result may be blurry, suggest fewer divisions
3. `cellWidth = floor(width / cols)`, `cellHeight = floor(height / rows)`
4. For each cell `[r, c]`:
   - `sharp.extract({ left: c*cellWidth, top: r*cellHeight, width: cellWidth, height: cellHeight })`
   - Resize to 100×100 (custom emoji size)
   - Convert to WEBP
5. Result: `Buffer[]` left-to-right, top-to-bottom

### Upload to Pack

1. Send progress message: "Uploading 0/{total}..."
2. For each buffer sequentially:
   - `uploadStickerFile` (format: static)
   - `addStickerToSet` with `emoji_list: ["🔲"]`, `keywords: ["mosaic", "r{row}c{col}"]`
   - Edit progress message every 3-5 uploads: "Uploading 12/35..."
   - `sendChatAction("upload_document")` to keep typing indicator
3. Store `file_id` of each added emoji
4. Store list of added sticker file_ids in scene state (for undo)

### Mosaic Message

1. Build text with custom_emoji entities:
   - Row 1: `emoji[0] emoji[1] emoji[2] emoji[3]`
   - Row 2: `emoji[4] emoji[5] emoji[6] emoji[7]`
   - Rows separated by `\n`
2. Telegram Bot API: `sendMessage` with `entities` array, each entry:
   - `type: "custom_emoji"`
   - `custom_emoji_id` from the uploaded sticker
3. Append pack link: `t.me/addemoji/{packName}`
4. Add inline button: `[🗑 Remove this mosaic]` → deletes all stickers
   from this mosaic from the pack via `deleteStickerFromSet`

## Scene Structure

```
Scene: "mosaic"

Entry:
  • Command /mosaic
  • Callback button from pack menu
  • Validate: user has a current custom_emoji pack
    → if not: offer to create one inline (enter pack title → create → continue)
    → not a dead end — seamless onboarding

Scene state (ctx.scene.state):
  • photoFileId    — file_id of current photo
  • photoWidth     — width
  • photoHeight    — height
  • messageId      — preview message id (for editing)
  • gridRows       — chosen rows (null until chosen)
  • gridCols       — chosen columns
  • lastMosaicIds  — file_ids of last uploaded mosaic (for undo)

Steps (non-linear loop):

  waitPhoto:
    → on("photo") → save fileId/dimensions to state
    → generate preview
    → send with inline keyboard
    → transition to waitGrid

  waitGrid:
    → on callback "mosaic:grid:{rows}:{cols}"
      → split, upload, send mosaic
      → clear state
      → back to waitPhoto

    → on callback "mosaic:custom"
      → send "Enter size (e.g. 3x4):"
      → transition to waitCustom

    → on callback "mosaic:cancel"
      → back to waitPhoto

  waitCustom:
    → on text → parse flexible formats: "RxC", "R×C", "R*C", "R:C", "R на C"
      → validate (2-10 each dimension, space in pack)
      → split, upload, send mosaic
      → back to waitPhoto

  Exit:
    → /mosaic again or "Exit" button
    → ctx.scene.leave()

Callback data format:
  "mosaic:grid:3:4"     — select 3×4 grid
  "mosaic:custom"       — enter custom size
  "mosaic:cancel"       — cancel current photo
  "mosaic:undo"         — remove last mosaic from pack
  "mosaic:exit"         — leave scene
```

## File Structure

### New files

| File | Purpose |
|------|---------|
| `scenes/mosaic.js` | Scene logic (waitPhoto → waitGrid → loop) |
| `utils/mosaic-split.js` | Sharp: split photo into grid cells |
| `utils/mosaic-preview.js` | Sharp: generate preview with grid overlay |
| `utils/mosaic-grid.js` | Grid recommendation algorithm |

### Modified files

| File | Change |
|------|--------|
| `bot.js` | Register mosaic scene + `/mosaic` command |
| `handlers/packs.js` | Add "🔲 Mosaic" button in pack menu (custom_emoji packs only) |
| `locales/*.yaml` | Mosaic-related text strings |

### Not modified

| File | Reason |
|------|--------|
| `utils/add-sticker.js` | Mosaic upload logic differs enough to warrant its own module |
| `database/models/*` | No new models needed — mosaic emoji are regular stickers in existing packs |

## Constraints

- Custom emoji are 100×100px and render small in chat
- Max 200 emoji per pack
- Grid max 50 cells (practical limit for usability)
- Individual dimensions: 2–10 for grid, 3–10 for strips
- If pack has insufficient space: warn user, suggest smaller grid or new pack
- Sequential upload required (Telegram rate limits)
- Min source cell size: 80×80px before resize (warn if smaller — blurry result)
- Custom emoji render with small gaps in Telegram — mosaic won't be pixel-perfect seamless
- Note in onboarding: emoji appear small in chat (~20px per emoji visually)
