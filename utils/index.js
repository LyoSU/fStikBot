const escapeHTML = require('./html-escape')
const userName = require('./user-name')
const addSticker = require('./add-sticker')
const addStickerText = require('./add-sticker-text')
const messaging = require('./messaging')
const updateUser = require('./user-update')
const updateGroup = require('./group-update')
const stats = require('./stats')
const tenor = require('./tenor')
const countUncodeChars = require('./unicode-chars-count')
const substrUnicode = require('./unicode-substr')
const telegramApi = require('./telegram-api')
const updateMonitor = require('./update-monitor')
const showGramAds = require('./gramads')
const downloadFileByURL = require('./download-file-by-url')
const moderatePack = require('./moderate-pack')
const escapeRegex = require('./escape-regex')
const { withRetry, isRateLimitError, getRetryAfter, retryMiddleware } = require('./retry-api')

module.exports = {
  escapeRegex,
  escapeHTML,
  userName,
  addSticker,
  addStickerText,
  messaging,
  updateUser,
  updateGroup,
  stats,
  tenor,
  countUncodeChars,
  substrUnicode,
  telegramApi,
  updateMonitor,
  showGramAds,
  downloadFileByURL,
  moderatePack,
  withRetry,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware
}
