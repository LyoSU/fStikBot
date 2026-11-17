// "Add to my pack" from the catalog: /start a_<pack>-<index>[-<check>] shows
// that one sticker with the usual add button (`add_sticker`), and the normal
// add path does the rest: the selected pack, the no-pack flow, the duplicate
// check, co-edit access, the public pack limit.
//
// A start payload is at most 64 characters of [A-Za-z0-9_-], and a pack name
// alone can be 64 characters of [A-Za-z0-9_], so the name can't always ride
// along whole:
//   a_<name>-<index>[-<check>]   the pack's full name
//   b_<stem>-<index>[-<check>]   a pack of this bot: <stem>_by_<bot username>.
//                                Telegram makes every pack this bot creates
//                                end in that suffix, so its packs always fit:
//                                stem <= 52, payload <= 64 with the check.
// No storage and nothing to expire: everything the link needs is in it. A
// pack of another bot, or one made through @Stickers, with a name over 58
// characters has no link — the catalog leaves the button out for it.
//
// <index> is the sticker's 0-based position in the pack, decimal. <check>
// (optional) is the first 5 characters of base64url(sha256(file_unique_id)):
// it confirms the sticker at <index> is still the one the catalog showed, and
// finds it when the pack was reordered. A hash and not a slice of the id
// itself: ids of stickers uploaded close together share long runs, and the
// part that differs sits in a different place for each kind of file.
const crypto = require('crypto')
const Markup = require('telegraf/markup')
const rateLimit = require('telegraf-ratelimit')
const packLink = require('../utils/pack-link')
const escapeHTML = require('../utils/html-escape')
const metrics = require('../utils/metrics')

const PAYLOAD_RE = /^([ab])_([A-Za-z0-9_]{1,64})-(0|[1-9]\d{0,2})(?:-([A-Za-z0-9_-]{5}))?$/
const CHECK_LENGTH = 5

/**
 * @param {string} payload the /start payload
 * @param {string} botUsername this bot's username, for the `b_` form
 * @returns {{name: string, index: number, check: string|null}|null}
 */
const parsePayload = (payload, botUsername) => {
  if (typeof payload !== 'string' || payload.length > 64) return null
  const match = PAYLOAD_RE.exec(payload)
  if (!match) return null

  const [, form, part, index, check] = match
  const name = form === 'b' ? `${part}_by_${botUsername}` : part
  // Telegram's own ceiling for a pack name.
  if (name.length > 64) return null

  return { name, index: Number(index), check: check || null }
}

const stickerCheck = (fileUniqueId) => crypto.createHash('sha256')
  .update(String(fileUniqueId))
  .digest('base64url')
  .slice(0, CHECK_LENGTH)

/**
 * The sticker the link means, or null when the pack no longer has it.
 * Without a check the position decides; with one, the sticker at the position
 * must match it, else the one that matches anywhere in the pack wins.
 */
const pickSticker = (stickers, index, check) => {
  if (!Array.isArray(stickers)) return null
  const atIndex = stickers[index] || null
  if (!check) return atIndex
  if (atIndex && stickerCheck(atIndex.file_unique_id) === check) return atIndex
  return stickers.find((sticker) => stickerCheck(sticker.file_unique_id) === check) || null
}

// The set behind a name: null when Telegram doesn't know it (a 400, which is
// STICKERSET_INVALID for a wrong or deleted name). Anything else — a timeout,
// a 429 — is ours to report, not the user's fault.
const fetchSet = (ctx, name) => ctx.telegram.getStickerSet(name).catch((err) => {
  if (err?.code === 400 || err?.response?.error_code === 400) return null
  throw err
})

// Each tap is a getStickerSet on the bot's token; the same budget as other
// buttons that cost Telegram calls.
const limiter = rateLimit({
  window: 10 * 1000,
  limit: 3,
  onLimitExceeded: (ctx) => ctx.replyWithHTML(ctx.i18n.t('error.rate_limit'))
})

const show = async (ctx, link) => {
  metrics.track('sticker_link_open')

  const set = await fetchSet(ctx, link.name)
  if (!set || !set.stickers?.length) {
    metrics.track('sticker_link_no_pack')
    return ctx.replyWithHTML(ctx.i18n.t('sticker.link.pack_not_found'))
  }

  const sticker = pickSticker(set.stickers, link.index, link.check)
  if (!sticker) {
    metrics.track('sticker_link_no_sticker')
    return ctx.replyWithHTML(ctx.i18n.t('sticker.link.sticker_not_found', {
      title: escapeHTML(set.title),
      link: packLink(set)
    }), {
      disable_web_page_preview: true
    })
  }

  return ctx.replyWithSticker(sticker.file_id, {
    reply_markup: Markup.inlineKeyboard([
      [{ ...Markup.callbackButton(ctx.i18n.t('sticker.link.btn_add'), 'add_sticker'), style: 'primary' }],
      [Markup.urlButton(ctx.i18n.t('sticker.link.btn_pack'), `https://${packLink(set)}`)]
    ])
  })
}

/**
 * /start handler for sticker links. `fallback` answers payloads that only look
 * like one (the welcome screen, like any unknown payload).
 */
const handleStickerLink = (fallback) => (ctx) => {
  // The add button only works in a private chat.
  if (ctx.chat?.type !== 'private') return fallback(ctx)
  const link = parsePayload(ctx.startPayload, ctx.options?.username || ctx.botInfo?.username)
  if (!link) return fallback(ctx)
  return limiter(ctx, () => show(ctx, link))
}

module.exports = handleStickerLink
module.exports.parsePayload = parsePayload
module.exports.pickSticker = pickSticker
module.exports.stickerCheck = stickerCheck
module.exports.show = show
module.exports.PAYLOAD_RE = PAYLOAD_RE
