// Videos picked in Studio, made into video stickers by the same converter and
// rules as a video sent in the chat. The API has neither the convert queue nor
// our Redis, so it leaves the file in a StudioVideo (fstikbot-api
// routes/api/studio/video.js) and this hands it on:
//
//   queued → converting → done (result) | failed (error)
//
// The converter downloads the file by its link to the API. The WebM goes back
// into the row and Studio fetches it from there; nothing is uploaded to
// Telegram here, that is the publish's job. The job carries no `input`, so the
// chat's completed/failed handlers in utils/add-sticker.js leave it alone.

const { convertPriority, maxVideoDuration, queueTooBusy } = require('./video-convert-rules')
const log = require('./logger').scope('studio-video')

const TICK_INTERVAL_MS = parseInt(process.env.STUDIO_VIDEO_TICK_MS, 10) || 1000
// The converter drops a job older than this (CONVERT_MAX_JOB_AGE_MS there).
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000
// A `converting` claim older than this is a dead process's: the job is lost
// with it, since a finished job's result lives only in its waiter.
const CLAIM_STALE_MS = CONVERT_TIMEOUT_MS + 60 * 1000
// A video that killed or outlived two claims is not tried a third time.
const MAX_ATTEMPTS = 2
// Conversions one process waits on at once; the converter's own workers and
// the queue's priorities decide what actually runs.
const MAX_IN_FLIGHT = parseInt(process.env.STUDIO_VIDEO_IN_FLIGHT, 10) || 10

const OUTCOME_ERROR = { disabled: 'unavailable', timeout: 'timeout', enqueue: 'convert', failed: 'convert' }

function mongoRepo (db) {
  return {
    claim: (now, staleBefore) => db.StudioVideo.findOneAndUpdate(
      {
        $or: [
          { status: 'queued' },
          { status: 'converting', claimedAt: { $lt: staleBefore } }
        ]
      },
      { $set: { status: 'converting', claimedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
      // The file stays in the database: the converter fetches it by link.
      { sort: { createdAt: 1 }, new: true, projection: { source: 0, result: 0 } }
    ).lean(),
    findUser: (telegramId) => db.User.findOne({ telegram_id: telegramId }).select('_id locale').lean(),
    countVideoPacks: (owner) => db.StickerSet.countDocuments({ owner, video: true }),
    // Only our own claim is settled; the source and its link go either way.
    settle: (video, set) => db.StudioVideo.updateOne(
      { _id: video._id, status: 'converting', claimedAt: video.claimedAt },
      { $set: { ...set, updatedAt: new Date() }, $unset: { source: 1, sourceKey: 1, sourceUrl: 1 } }
    )
  }
}

function videoSize (metadata) {
  const stream = metadata?.streams?.find((s) => s.codec_type === 'video')

  return { width: stream?.width || 0, height: stream?.height || 0 }
}

/**
 * @param {Object} deps
 * @param {Object} deps.repo database access (mongoRepo)
 * @param {Object} deps.queue the convert queue (utils/queues.js)
 * @param {Function} deps.runJob utils/queue-job.js runQueueJob
 * @param {Function} [deps.now]
 */
function createVideoConverter ({ repo, queue, runJob, now = () => new Date() }) {
  let timer = null
  let ticking = null
  let stopping = false
  const inFlight = new Set()

  const fail = (video, error) => repo.settle(video, { status: 'failed', error })

  async function convert (video) {
    if ((video.attempts || 0) > MAX_ATTEMPTS) return fail(video, 'timeout')
    if (queue.disabled) return fail(video, 'unavailable')

    const isEmoji = video.packType === 'custom_emoji'
    const user = await repo.findUser(video.telegramId)
    const videoPacks = user ? await repo.countVideoPacks(user._id) : 0
    const priority = convertPriority({ videoPacks, locale: user?.locale, boost: video.boost })

    const counts = await queue.getJobCounts().catch(() => ({ waiting: 0 }))
    if (queueTooBusy(counts.waiting, priority)) return fail(video, 'busy')

    // The job the chat sends, minus `input`: the same frame, crop and length.
    const outcome = await runJob(queue, {
      fileUrl: video.sourceUrl,
      timestamp: Date.now(),
      isEmoji,
      frameType: video.frameType || 'square',
      forceCrop: isEmoji,
      maxDuration: maxVideoDuration(video.boost)
    }, { priority, timeoutMs: CONVERT_TIMEOUT_MS })

    if (outcome.error) {
      log.warn(`video ${video._id}: ${outcome.error}`, outcome.cause?.message || '')
      return fail(video, OUTCOME_ERROR[outcome.error] || 'convert')
    }

    const result = Buffer.from(outcome.result.content, 'base64')
    const { width, height } = videoSize(outcome.result.metadata)

    await repo.settle(video, { status: 'done', result, size: result.length, width, height })
    log.info(`video ${video._id}: ${result.length} B, ${width}x${height}`)
  }

  function track (video) {
    const run = convert(video)
      .catch(async (err) => {
        log.error(`video ${video._id}:`, err.stack || err.message)
        await fail(video, 'convert').catch(() => {})
      })
      .finally(() => inFlight.delete(run))

    inFlight.add(run)
  }

  // Claims while there is room; each conversion is waited on apart.
  async function tick () {
    if (ticking || stopping) return
    ticking = (async () => {
      try {
        while (inFlight.size < MAX_IN_FLIGHT) {
          if (stopping) break
          const at = now()
          const video = await repo.claim(at, new Date(at.getTime() - CLAIM_STALE_MS))
          if (!video) break
          track(video)
        }
      } catch (err) {
        log.error('tick failed:', err.stack || err.message)
      } finally {
        ticking = null
      }
    })()
    await ticking
  }

  /** Waits for every conversion started so far (tests, shutdown). */
  const settled = () => Promise.allSettled([...inFlight])

  function start () {
    if (timer) return
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  // A conversion cut short here is claimed again once its claim goes stale.
  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (ticking) await ticking.catch(() => {})
  }

  return { start, stop, tick, settled }
}

let instance = null

function getVideoConverter () {
  if (!instance) {
    const { db } = require('../database')
    const { convertQueue } = require('./queues')
    const { runQueueJob } = require('./queue-job')
    instance = createVideoConverter({ repo: mongoRepo(db), queue: convertQueue, runJob: runQueueJob })
  }
  return instance
}

module.exports = {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  createVideoConverter,
  mongoRepo,
  start: () => getVideoConverter().start(),
  stop: () => (instance ? instance.stop() : Promise.resolve())
}
