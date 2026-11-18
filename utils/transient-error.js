// Failures that say nothing about the request itself: Telegram either never
// answered (a dropped connection) or answered from a proxy that lost the
// request (502/504) or from a server having a bad moment (500/503).
//
// Such a request may or may not have been carried out, so only a call that
// changes nothing may be repeated blindly. Prod 2026-11-17: 700+ adds failed
// with "something went wrong" on a 502/504 from getFile and getStickerSet,
// calls that are safe to repeat and were never retried.

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'])
const NETWORK_MESSAGE = /socket hang up|Client network socket disconnected/i

// No HTTP response from Telegram at all. Anything carrying a numeric Telegram
// code (a TelegramError: 400, 429, 5xx) did get an answer.
const isNetworkError = (error) => {
  if (!error) return false
  if (Number.isInteger(error.code ?? error.response?.error_code)) return false
  return error.type === 'system' ||
    error.name === 'FetchError' ||
    NETWORK_CODES.has(error.code) ||
    NETWORK_MESSAGE.test(error.message || '')
}

// Any 5xx: the server's failure, whatever it did with the request.
const isServerError = (error) => {
  const code = Number(error?.code ?? error?.response?.error_code)
  return code >= 500 && code < 600
}

/** A dropped connection or a Telegram 5xx: the outcome of the call is unknown. */
const isTransientError = (error) => isNetworkError(error) || isServerError(error)

module.exports = { isNetworkError, isServerError, isTransientError }
