// Banner runtime helpers.
//
// Flow: first call uploads the PNG from disk, Telegram returns a file_id,
// we cache it in RAM keyed by {name}:{mtimeMs}. Every subsequent call uses
// the cached file_id — Telegram serves it from its own CDN, no file transfer.
// Cache wipes on restart (one re-upload per banner per deploy). Cache key
// includes mtime, so rebuilding banners/dist/*.png auto-invalidates without
// any manual bust.
//
// Why RAM not Redis: banners are a tiny number (~3–10), file_ids are short
// strings, losing cache on restart costs one re-upload per banner — Redis
// complexity isn't worth it here.
//
// Navigation note: Telegram allows editing a text message INTO a media
// message via editMessageMedia, but NOT the reverse. So once /start sends
// a banner (photo + caption + keyboard), subsequent navigation within that
// message stays media-based forever — we use editMessageCaption to change
// only the text/keyboard (banner unchanged), or editMessageMedia to swap
// to a different banner.

const fs = require('fs')
const path = require('path')

const DIST = path.join(__dirname, 'dist')

const cache = new Map()

function resolveBanner (name) {
  const file = path.join(DIST, `${name}.png`)
  if (!fs.existsSync(file)) return null
  const { mtimeMs } = fs.statSync(file)
  return { file, cacheKey: `${name}:${Math.floor(mtimeMs)}` }
}

function photoInput (banner) {
  return cache.get(banner.cacheKey) || { source: fs.createReadStream(banner.file) }
}

function rememberFileId (banner, message) {
  const photos = message?.photo
  if (!photos?.length) return
  // Largest size — Telegram reuses this file_id across all size requests
  cache.set(banner.cacheKey, photos[photos.length - 1].file_id)
}

function assertBanner (name) {
  const b = resolveBanner(name)
  if (!b) throw new Error(`[banners] missing dist/${name}.png — run: node banners/build.js`)
  return b
}

// First-time send (from a /command or plain message trigger).
async function sendBanner (ctx, name, caption = '', extra = {}) {
  const banner = assertBanner(name)
  const msg = await ctx.replyWithPhoto(photoInput(banner), {
    caption,
    parse_mode: 'HTML',
    ...extra
  })
  rememberFileId(banner, msg)
  return msg
}

// Swap the current message's banner (use when navigating between *different*
// banners: e.g. /start welcome → catalog). Works whether the prior message
// was text (upgrades it) or already a photo (replaces the media).
//
// Implementation note: Telegraf 3.40's ctx.editMessageMedia(media, extra)
// merges `extra` INTO the InputMedia object instead of sending it at the API
// top level. That buries `reply_markup` where the Telegram API never sees it
// — keyboard doesn't update, and on multipart uploads the caption can get
// stripped too. So we do it in two calls:
//   1. editMessageMedia — swap the photo only
//   2. editMessageCaption — set caption + inline keyboard
// Each call does one thing cleanly; no silent drops.
async function editBanner (ctx, name, caption = '', extra = {}) {
  const banner = assertBanner(name)
  const source = photoInput(banner)
  const media = {
    type: 'photo',
    media: typeof source === 'string' ? source : { source: fs.createReadStream(banner.file) }
  }
  try {
    const edited = await ctx.editMessageMedia(media)
    if (edited && typeof edited === 'object') rememberFileId(banner, edited)

    await ctx.editMessageCaption(caption, {
      parse_mode: 'HTML',
      reply_markup: extra.reply_markup
    }).catch(() => {}) // benign: MESSAGE_NOT_MODIFIED if nothing actually changed

    return edited
  } catch (err) {
    // Message too old / not editable — fall back to a fresh send so the user
    // still sees something rather than a silent no-op.
    return sendBanner(ctx, name, caption, extra)
  }
}

// In-place text/keyboard edit without touching the banner. Use when the user
// navigates WITHIN the same banner section (e.g. paging through packs).
// Auto-picks editMessageCaption (if current message is a photo) or
// editMessageText (if it's still plain text) — this keeps legacy text-only
// flows working while photo-based flows just work too.
async function editMenu (ctx, text, extra = {}) {
  const msg = ctx.callbackQuery?.message
  const isPhoto = !!(msg && msg.photo)
  const opts = { parse_mode: 'HTML', ...extra }
  try {
    if (isPhoto) {
      return await ctx.editMessageCaption(text, opts)
    }
    return await ctx.editMessageText(text, opts)
  } catch (err) {
    // benign: message-not-modified / message-to-edit-not-found
  }
}

// Convenience: pick sendBanner vs editBanner by trigger type. Use in handlers
// that can be reached both as a command and as a callback from another menu.
async function replyOrEditBanner (ctx, name, caption = '', extra = {}) {
  if (ctx.callbackQuery) return editBanner(ctx, name, caption, extra)
  return sendBanner(ctx, name, caption, extra)
}

module.exports = { sendBanner, editBanner, editMenu, replyOrEditBanner }
