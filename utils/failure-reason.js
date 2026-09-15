const { matchTelegramErrorReason } = require('./telegram-error')

// A short, bounded name for why an add failed, for metric counters like
// "sticker_failed_pack_full". Raw Telegram descriptions are never used —
// every distinct string would become its own counter field.
const failureReason = (result) => {
  const error = result?.error
  if (!error) return 'other'

  if (error.telegram) {
    const reason = matchTelegramErrorReason(error.telegram)
    if (reason) return reason
    const code = Number(error.telegram.code)
    return Number.isInteger(code) && code > 0 ? `telegram_${code}` : 'telegram_other'
  }

  // "sticker.add.error.too_big" → "too_big"
  if (typeof error.i18nKey === 'string') {
    return error.i18nKey.split('.').pop().replace(/[^a-z0-9_]/gi, '_') || 'other'
  }

  return 'other'
}

module.exports = { failureReason }
