// answerCallbackQuery text: Telegram caps it at 200 characters and renders no
// HTML at all. Our i18n strings are written for replyWithHTML, and several
// locales run well past 200 (sticker.add.error.convert is 294 chars in fr,
// wait_load is 255 in de) — the restore button surfaced that in prod as
// `400: Bad Request: MESSAGE_TOO_LONG`. Clamp once, centrally, instead of
// remembering at every call site.

const CALLBACK_TEXT_MAX = 200

const ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'"
}

const clampCallbackText = (text) => {
  if (typeof text !== 'string') return text

  const plain = text
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITIES[m])
    .trim()

  // Count code points, not UTF-16 units — Telegram counts characters and
  // emoji are two units each.
  const chars = [...plain]
  if (chars.length <= CALLBACK_TEXT_MAX) return plain
  return chars.slice(0, CALLBACK_TEXT_MAX - 1).join('') + '…'
}

/**
 * Wrap ctx.answerCbQuery so every alert text is clamped. Idempotent per ctx;
 * a ctx without a callbackQuery is left alone.
 */
const wrapAnswerCbQuery = (ctx) => {
  if (!ctx?.callbackQuery || typeof ctx.answerCbQuery !== 'function') return
  const original = ctx.answerCbQuery
  ctx.answerCbQuery = (text, ...rest) => original.call(ctx, clampCallbackText(text), ...rest)
}

module.exports = { clampCallbackText, wrapAnswerCbQuery, CALLBACK_TEXT_MAX }
