// Which emoji of a draft Telegram refused. "can't parse InputSticker: expected
// a Unicode emoji" names no sticker, and a pictograph is not always an emoji
// (♡, ★, ♪ are not), so the failure line says which one it was, as code
// points: enough to see the symbol, nothing about the user.

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

const isEmoji = (text) => typeof text === 'string' && text.length <= 64 && RGI.test(qualified(text))

const codePoints = (text) => [...String(text)].slice(0, 16)
  .map((point) => `U+${point.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  .join(' ')

const EMOJI_REFUSED = /expected a Unicode emoji|EMOJI_INVALID/i

/**
 * Log fields for a commit Telegram refused over an emoji: the position of the
 * first sticker in the draft with an emoji it can't take, and that emoji as
 * code points. Empty for any other failure, or when no emoji looks wrong.
 *
 * @returns {{ sticker?: number, emoji?: string }}
 */
function emojiContext (commit) {
  if (!EMOJI_REFUSED.test(String(commit?.error || ''))) return {}

  const draft = Array.isArray(commit.draft) ? commit.draft : []
  for (let i = 0; i < draft.length; i++) {
    const list = Array.isArray(draft[i]?.emojiList) ? draft[i].emojiList : []
    const bad = list.length ? list.find((emoji) => !isEmoji(emoji)) : ''
    if (bad !== undefined) return { sticker: i, emoji: bad ? codePoints(bad) : 'none' }
  }
  return {}
}

module.exports = { emojiContext, isEmoji, codePoints }
