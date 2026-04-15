# Mosaic Input Types — Design Spec

## Overview

Extend the mosaic feature (`scenes/mosaic.js`) to accept more input types beyond `message.photo`. Specifically: image documents (JPEG/PNG/WebP) and static stickers. Animated and video stickers, GIFs, and videos are explicitly **out of scope** for this iteration.

## Motivation

- `message.photo` is recompressed by Telegram to ~1280px max, hurting mosaic quality. Users who want crisp mosaics currently have no path.
- People naturally try to mosaic an existing sticker; the bot silently ignores it (no feedback).
- Sharp (already in the pipeline) decodes JPEG/PNG/WebP natively, so the processing pipeline needs **zero changes**.

## Scope

### In scope

| Input | Condition | Source field |
|---|---|---|
| `message.photo` | any | largest variant `file_id` |
| `message.document` | `mime_type` ∈ `image/jpeg`, `image/png`, `image/webp` | `document.file_id` |
| `message.sticker` | `!is_animated && !is_video` | `sticker.file_id` |

### Out of scope (reject with clear message)

- Animated stickers (`.tgs`)
- Video stickers (`.webm`)
- `message.animation`, `message.video`, `message.video_note` (GIFs/videos)
- Documents with non-image MIME types

### Non-goals

- Producing an animated/video mosaic
- Converting `.tgs`/`.webm` to static before processing
- Respecting `has_spoiler` flag (treat as regular image)

## Architecture

### Single handler, multiple types

Replace:
```js
mosaic.on('photo', async (ctx) => { ... })
```

With a unified handler bound to `['photo', 'document', 'sticker']` that delegates validation to `getMosaicSource`. Add a second lightweight handler for `['animation', 'video', 'video_note']` that replies with `cmd.mosaic.reject_media` and returns — it never calls `getMosaicSource`.

### Source normalization helper

An inline private function `getMosaicSource(message)` returns one of:

- `{ fileId, width, height }` — on success
- `{ error: '<i18n-key>' }` — on rejection

Keeps the scene handler linear; no new file until we need one (YAGNI — if Option B/C land later, extract to `utils/mosaic-source.js` then).

| Input | Return |
|---|---|
| `message.photo` present | `{ fileId: largest.file_id, width: largest.width, height: largest.height }` |
| `message.document` with image MIME | `{ fileId, width: document.thumb?.width, height: document.thumb?.height }` — see note below |
| `message.sticker`, static only | `{ fileId, width: sticker.width, height: sticker.height }` |
| `message.sticker`, animated/video | `{ error: 'cmd.mosaic.reject_animated' }` |
| `message.document`, non-image MIME | `{ error: 'cmd.mosaic.reject_document' }` |

**Note on document dimensions:** `message.document` doesn't carry width/height directly — only the thumbnail does, and it's optional. When dimensions aren't available from the message, read them from the downloaded buffer via `sharp(buffer).metadata()` before the grid-suggestion step. This is a single extra `sharp` call, no extra download.

### Processing pipeline — unchanged

`cropToAspectRatio`, `splitImage`, `generatePreview`, upload flow — all untouched. Sharp already handles JPEG/PNG/WebP transparently.

## UX

### New rejection messages (i18n)

Added under `cmd.mosaic.*` in all locales (following existing mosaic key structure in `locales/*.yaml:318`):

```yaml
cmd.mosaic.reject_animated: |
  Анімовані/відео стікери поки не підтримую. Надішліть статичний стікер, фото або PNG/JPEG/WebP файлом.
cmd.mosaic.reject_document: |
  Підтримую тільки зображення (JPEG/PNG/WebP). Надішліть файл у цьому форматі.
cmd.mosaic.reject_media: |
  Анімації та відео поки не підтримую. Надішліть статичний стікер, фото або PNG/JPEG/WebP файлом.
```

Ukrainian and English locales get proper translations; other 15 locales fall back to English (existing pattern).

### Rejection behaviour

- Reply with the appropriate message
- **Do not leave the scene** — user can immediately resend a valid input
- No cleanup of scene state needed (the failed input never wrote any state)

### Success behaviour

Identical to current photo flow: compute grid suggestions, send preview, await button tap.

## Error handling

- **Document download fails** → existing `downloadFile` error path applies (20MB cap, 3 retries)
- **Sharp fails to decode** (corrupted WebP, e.g.) → existing try/catch around `generatePreview` applies. Add a specific reply `cmd.mosaic.invalid_image` only if testing reveals this is a common path; otherwise leave to existing error handler.
- **Document with image MIME but actually not an image** (spoofed) → sharp throws, falls through to existing error handling. Good enough.

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Large PNG (20MB) causes sharp OOM | Low | Existing 20MB download cap. If OOM observed in prod, add `sharp.metadata()` pre-check and reject if decoded pixels > threshold. Not doing preemptively. |
| WebP with alpha produces emoji with transparent edges | Medium | Acceptable — Telegram custom emoji support alpha. Verify visually after first build. |
| User sends a static sticker that's 512×512 — mosaic tiles become 100×100 crops of that | Low | Current pipeline handles this fine (same as a 512×512 photo). No special case. |
| Telegram adds new sticker format | Unknown | `is_animated`/`is_video` flags are the documented API; if a new one appears, it'll fall through to the sticker-accepted path. Monitor. |

## Testing

Manual smoke after implementation:

1. Send a photo → works as before
2. Send a PNG as document → processes, produces mosaic
3. Send a JPEG as document → works
4. Send a WebP as document → works
5. Send a static sticker → works
6. Send an animated (.tgs) sticker → rejection message, scene stays open
7. Send a video (.webm) sticker → rejection message, scene stays open
8. Send a GIF (animation) → rejection message
9. Send a PDF document → rejection message
10. After rejection, send a valid photo → works (scene didn't leave)

No automated tests added (consistent with existing mosaic code — no tests exist for the scene today).

## Files touched

- `scenes/mosaic.js` — replace the `mosaic.on('photo')` handler with multi-type handler + add `getMosaicSource` helper + add animation/video reject handler
- `locales/uk.yaml` — add 3 new keys under `cmd.mosaic`
- `locales/en.yaml` — add 3 new keys under `cmd.mosaic`

## Out of scope for this spec (explicit)

- Video mosaic (split `.webm` sticker into NxM video custom emoji) — separate spec when/if demand appears
- Animated Lottie (`.tgs`) rendering — would require Lottie renderer, separate spec
- GIF/video inputs — same as above
- Changing the grid algorithm or upload pipeline
- Adding automated tests for the mosaic scene
