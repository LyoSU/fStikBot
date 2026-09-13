// Barrel for the helpers handlers/scenes import together. Only things that are
// actually consumed through the barrel live here — leaf modules with a single
// consumer are required directly.
const escapeHTML = require('./html-escape')
const userName = require('./user-name')
const addSticker = require('./add-sticker')
const addStickerText = require('./add-sticker-text')
const updateUser = require('./user-update')
const updateGroup = require('./group-update')
const stats = require('./stats')
const tenor = require('./tenor')
const countUncodeChars = require('./unicode-chars-count')
const substrUnicode = require('./unicode-substr')
const telegramApi = require('./telegram-api')
const updateMonitor = require('./update-monitor')
const showGramAds = require('./gramads')
const escapeRegex = require('./escape-regex')
const { deriveStickerFlags } = require('./sticker-type')
const { isRateLimitError, getRetryAfter, retryMiddleware } = require('./retry-api')

module.exports = {
  escapeRegex,
  deriveStickerFlags,
  escapeHTML,
  userName,
  addSticker,
  addStickerText,
  updateUser,
  updateGroup,
  stats,
  tenor,
  countUncodeChars,
  substrUnicode,
  telegramApi,
  updateMonitor,
  showGramAds,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware
}
