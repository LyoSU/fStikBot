// How a video waits for the converter, for a video sent in the chat
// (utils/add-sticker.js) and one picked in Studio alike: fstikbot-api adds
// Studio's jobs itself with a copy of these rules (utils/studio/convert-rules.js,
// whose test compares the two); keep them in step.
//
// Bull serves the lowest priority number first, strictly, and can't change a
// waiting job's priority. A plain tier number therefore starved the low tiers:
// under steady load a ru user's video waited behind every newer video until
// the converter dropped it as too old (bursts of hundreds, whenever a bot
// restart paused the inflow long enough for the backlog to be reached).
//
// So the priority is a virtual deadline: the moment the job was added plus
// the head start its tier gives away. Boost gives none; everyone else a
// little, more for heavy owners and ru. A job is overtaken only by jobs added
// less than its own delay after it, so the order is kept and no wait grows
// without bound: the effective priority ages for free, with nothing to update.

// With this many jobs waiting, a low-rank one is turned away at enqueue.
const BUSY_WAITING = 200
const BUSY_RANK = 50

// Seconds given away: the base for anyone without Boost, one per three video
// packs up to a cap, and the extra for ru.
const BASE_DELAY_S = 20
const MAX_OWNER_DELAY_S = 60
const RU_DELAY_S = 120

// Deadlines count seconds from here, so they stay small integers for years.
const EPOCH_MS = Date.UTC(2026, 0, 1)

/** The policy's rank, the same scale as before: what "too busy" is judged by. */
function convertRank ({ videoPacks = 0, locale, boost }) {
  if (boost) return 5

  let rank = Math.round(videoPacks / 3)
  if (locale === 'ru') rank += 40

  return rank
}

/** Seconds of head start the tier gives away. */
function convertDelay ({ videoPacks = 0, locale, boost }) {
  if (boost) return 0

  return BASE_DELAY_S +
    Math.min(Math.round(videoPacks / 3), MAX_OWNER_DELAY_S) +
    (locale === 'ru' ? RU_DELAY_S : 0)
}

/** Bull priority (lower goes first): the job's deadline in seconds; never 0, which Bull reads as "none". */
function convertPriority (owner, now = Date.now()) {
  return Math.max(1, Math.floor((now - EPOCH_MS) / 1000) + convertDelay(owner))
}

/** Seconds of the video the converter keeps; the WebM header still says 2.9. */
const maxVideoDuration = (boost) => (boost ? 35 : 4)

const queueTooBusy = (waiting, rank) => waiting > BUSY_WAITING && rank > BUSY_RANK

// The converter fails a job that waited past its age limit with this code
// (fStikBot-video-converter src/queue.js); older converters said "Job timeout -
// older than". Either way it is load, not the video.
const TOO_OLD = /\btoo_old\b|Job timeout - older than/

const isTooOld = (reason) => TOO_OLD.test(String(reason || ''))

/**
 * What a failed chat conversion means. A job that waited too long is load: the
 * user hears "high load", it counts as a timeout, and it is a warning with no
 * message to the log chat. Anything else is the video or the converter.
 *
 * @param {string} reason Bull's failedReason
 */
function convertFailure (reason) {
  const timedOut = reason === 'timeout' || isTooOld(reason)

  return timedOut
    ? { code: 'too_old', level: 'warn', i18nKey: 'sticker.add.error.timeout', metric: 'timeout', logChat: false }
    : { code: 'failed', level: 'error', i18nKey: 'sticker.add.error.convert', metric: 'convert', logChat: true }
}

/** The fields a queue line carries about its job, for grouping in the logs. */
function jobFields (job) {
  return {
    jobId: job?.id === undefined ? undefined : String(job.id),
    priority: job?.opts?.priority,
    waitMs: job?.processedOn && job?.timestamp ? job.processedOn - job.timestamp : undefined
  }
}

module.exports = { convertRank, convertDelay, convertPriority, maxVideoDuration, queueTooBusy, isTooOld, convertFailure, jobFields }
