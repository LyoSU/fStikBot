// Which emoji of a draft Telegram refused. "can't parse InputSticker: expected
// a Unicode emoji" names no sticker, and a pictograph is not always an emoji
// (♡, ★, ♪ are not), so the failure line says which one it was, as code
// points: enough to see the symbol, nothing about the user.

const { planMetadata } = require('./plan')

// The emoji Unicode recommends for general use, fully qualified. Telegram
// takes an emoji with or without its selectors (measured), so a candidate is
// compared with every selector where the qualified form has one.
// A constructor: the linter's parser doesn't know the v flag (Node 20+ does).
// eslint-disable-next-line prefer-regex-literals, no-invalid-regexp
const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v')
const TEXT_DEFAULT = /\p{Emoji}/u
const EMOJI_DEFAULT = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u
const MODIFIER = /\p{Emoji_Modifier}/u

function qualified (text) {
  const points = [...text.replace(/\uFE0F/g, '')]
  return points.map((point, i) => (
    TEXT_DEFAULT.test(point) && !EMOJI_DEFAULT.test(point) && !MODIFIER.test(points[i + 1] || '') ? `${point}\uFE0F` : point
  )).join('')
}

// A pictograph code point this Unicode doesn't know yet (an emoji newer than
// Node's ICU) is not blamed.
const UNKNOWN_PICTOGRAPH = /(?=\p{Extended_Pictographic})\p{Cn}/u

const isEmoji = (text) => typeof text === 'string' && text.length <= 64 &&
  (RGI.test(qualified(text)) || UNKNOWN_PICTOGRAPH.test(text))

const codePoints = (text) => [...String(text)].slice(0, 16)
  .map((point) => `U+${point.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  .join(' ')

const EMOJI_REFUSED = /expected a Unicode emoji|EMOJI_INVALID/i

// Whether the commit sends this item's emoji to Telegram: a new or replaced
// sticker carries them, a kept one only when they changed (planMetadata). A
// sticker added outside the draft ('o:') sends none.
function sendsEmoji (item, known) {
  if (!item || String(item.assetId || '').startsWith('o:')) return false
  if (item.file || !item.fileUniqueId) return true
  return planMetadata([item], known).some((update) => update.emojiList)
}

/**
 * Log fields for a commit Telegram refused over an emoji: the position (in
 * the draft as sent) of the first sticker whose emoji went to Telegram and
 * hold one it can't take, and that emoji as code points. Empty for any other
 * failure, or when no emoji looks wrong.
 *
 * @returns {{ sticker?: number, emoji?: string }}
 */
function emojiContext (commit) {
  if (!EMOJI_REFUSED.test(String(commit?.error || ''))) return {}

  const draft = Array.isArray(commit.draft) ? commit.draft : []
  // A draft carried over outside changes is the one published.
  const sent = Array.isArray(commit.rebased) ? commit.rebased : draft
  const known = new Map(Object.entries(commit.known || {}))
  for (let i = 0; i < sent.length; i++) {
    if (!sendsEmoji(sent[i], known)) continue
    const list = Array.isArray(sent[i].emojiList) ? sent[i].emojiList : []
    const bad = list.length ? list.find((emoji) => !isEmoji(emoji)) : ''
    if (bad === undefined) continue
    const at = sent === draft ? i : draft.findIndex((item) => item?.assetId === sent[i].assetId)
    return { sticker: at === -1 ? i : at, emoji: bad ? codePoints(bad) : 'none' }
  }
  return {}
}

module.exports = { emojiContext, isEmoji, codePoints }
