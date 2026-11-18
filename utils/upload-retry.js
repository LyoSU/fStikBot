// uploadStickerFile with a retry on transient failures. Uploading a file only
// returns a file_id and has no side effects, so resending is safe — unlike
// addStickerToSet, where a retried add can duplicate a sticker.
// retry-api's withRetry covers 429 (and 5xx only for get* reads); a connection
// dropped mid-upload ("request to .../uploadStickerFile failed, reason: ") or a
// 502/504 from Telegram used to fail the add.
const { isNetworkError, isTransientError } = require('./transient-error')

// Wait before retry 1 and retry 2: 3 attempts in total.
const RETRY_DELAYS_MS = [1000, 3000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every source reaching here is a Buffer (see add-sticker.js), so resending the
// same params is safe; a consumed stream could not be.
// Resolves to the uploaded file, or { error: { telegram } } like the caller expects.
const uploadStickerFile = async (telegram, params, { delaysMs = RETRY_DELAYS_MS, onRetry } = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await telegram.callApi('uploadStickerFile', params)
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransientError(error)) {
        return { error: { telegram: error } }
      }
      if (onRetry) onRetry(error, attempt + 1)
      await sleep(delaysMs[attempt])
    }
  }
}

module.exports = { uploadStickerFile, isNetworkError, RETRY_DELAYS_MS }
