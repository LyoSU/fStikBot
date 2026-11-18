// When the placeholder sweeper looks at a pack (utils/placeholder-sweeper.js).
// Pure, no DB import: database/index.js uses it when a pack is created.
//
// A pack gets a handful of looks, spread out: soon after creation (the user is
// usually adding stickers right then), then the same day, the next day and a
// week later. A pack that still holds only the placeholder after that is
// almost always abandoned, and the bot's own add path still cleans it up if
// the owner ever comes back. About 4 getStickerSet calls per new pack in all.
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// Delay before look N+1, counted from look N (the first from creation).
const CHECK_DELAYS_MS = [15 * MINUTE, 2 * HOUR, 22 * HOUR, 6 * 24 * HOUR]

// Retry soon after a look that failed for a reason unrelated to the pack
// (Telegram 5xx, a dropped connection): it doesn't use up a look.
const RETRY_AFTER_ERROR_MS = 10 * MINUTE

const firstPlaceholderCheck = (now = Date.now()) => new Date(now + CHECK_DELAYS_MS[0])

/**
 * @param {number} checksDone looks already made, this one included
 * @returns {Date|null} when to look next, or null when there are no more looks
 */
const nextPlaceholderCheck = (checksDone, now = Date.now()) => {
  const delay = CHECK_DELAYS_MS[checksDone]
  return delay ? new Date(now + delay) : null
}

module.exports = { CHECK_DELAYS_MS, RETRY_AFTER_ERROR_MS, firstPlaceholderCheck, nextPlaceholderCheck }
