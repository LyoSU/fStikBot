// How a video waits for the converter, for a video sent in the chat
// (utils/add-sticker.js) and one picked in Studio (utils/studio-video.js) alike.

// With this many jobs waiting, a low-priority one is turned away instead.
const BUSY_WAITING = 200
const BUSY_PRIORITY = 50

/** Bull priority: lower goes first. Boost jumps the queue. */
function convertPriority ({ videoPacks = 0, locale, boost }) {
  if (boost) return 5

  let priority = Math.round(videoPacks / 3)
  if (locale === 'ru') priority += 40

  return priority
}

/** Seconds of the video the converter keeps; the WebM header still says 2.9. */
const maxVideoDuration = (boost) => (boost ? 35 : 4)

const queueTooBusy = (waiting, priority) => waiting > BUSY_WAITING && priority > BUSY_PRIORITY

module.exports = { convertPriority, maxVideoDuration, queueTooBusy }
