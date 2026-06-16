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
const downloadFileByURL = require('./download-file-by-url')
const moderatePack = require('./moderate-pack')
const escapeRegex = require('./escape-regex')
const { deriveStickerFlags, flagsToType, stickerSetType } = require('./sticker-type')
const { withRetry, isRateLimitError, getRetryAfter, retryMiddleware, clearBlockedChat, getRateLimitRemaining } = require('./retry-api')
const { perfStage, perfRecord, perfTick, perfSnapshot, ENABLED: PERF_TIMING_ENABLED } = require('./perf-timing')

module.exports = {
  escapeRegex,
  deriveStickerFlags,
  flagsToType,
  stickerSetType,
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
  downloadFileByURL,
  moderatePack,
  withRetry,
  isRateLimitError,
  getRetryAfter,
  retryMiddleware,
  clearBlockedChat,
  getRateLimitRemaining,
  perfStage,
  perfRecord,
  perfTick,
  perfSnapshot,
  PERF_TIMING_ENABLED
}
