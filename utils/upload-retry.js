// uploadStickerFile with a retry on network-level failures. Uploading a file
// only returns a file_id and has no side effects, so resending is safe —
// unlike addStickerToSet, where a retried add can duplicate a sticker.
// retry-api's withRetry covers 429 only; a connection dropped mid-upload
// ("request to .../uploadStickerFile failed, reason: ") used to fail the add.

// Wait before retry 1 and retry 2: 3 attempts in total.
const RETRY_DELAYS_MS = [1000, 3000]

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'])
const NETWORK_MESSAGE = /socket hang up|Client network socket disconnected/i

// No HTTP response from Telegram at all. Anything carrying a numeric Telegram
// code (a TelegramError: 400, 429, 5xx) did get an answer and is not retried.
const isNetworkError = (error) => {
  if (!error) return false
  if (Number.isInteger(error.code ?? error.response?.error_code)) return false
  return error.type === 'system' ||
    error.name === 'FetchError' ||
    NETWORK_CODES.has(error.code) ||
    NETWORK_MESSAGE.test(error.message || '')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every source reaching here is a Buffer (see add-sticker.js), so resending the
// same params is safe; a consumed stream could not be.
// Resolves to the uploaded file, or { error: { telegram } } like the caller expects.
const uploadStickerFile = async (telegram, params, { delaysMs = RETRY_DELAYS_MS, onRetry } = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await telegram.callApi('uploadStickerFile', params)
    } catch (error) {
      if (attempt >= delaysMs.length || !isNetworkError(error)) {
        return { error: { telegram: error } }
      }
      if (onRetry) onRetry(error, attempt + 1)
      await sleep(delaysMs[attempt])
    }
  }
}

module.exports = { uploadStickerFile, isNetworkError, RETRY_DELAYS_MS }
