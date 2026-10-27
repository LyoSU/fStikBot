// Videos picked in Studio, made into video stickers by the same converter and
// rules as a video sent in the chat. The API has neither the convert queue nor
// our Redis, so it leaves the file in a StudioVideo (fstikbot-api
// routes/api/studio/video.js) and this hands it on:
//
//   queued → converting → done (result) | failed (error)
//
// While converting, the row says whether the job still waits in the convert
// queue (`waiting`, behind the chat's videos: minutes in the evening) or the
// converter has started it (`startedAt`), so Studio can tell a line from a
// conversion.
//
// The converter downloads the file by its link to the API. The WebM goes back
// into the row and Studio fetches it from there; nothing is uploaded to
// Telegram here, that is the publish's job. The job carries no `input`, so the
// chat's completed/failed handlers in utils/add-sticker.js leave it alone.

const { convertPriority, convertRank, maxVideoDuration, queueTooBusy, isTooOld } = require('./video-convert-rules')
const log = require('./logger').scope('studio-video')
const { logError, logEvent } = require('./error-line')
const { logUid } = require('./log-uid')

const TICK_INTERVAL_MS = parseInt(process.env.STUDIO_VIDEO_TICK_MS, 10) || 1000
// How long Studio's video waits on its job. The job asks the converter to drop
// it past the same age (maxAgeMs), so nothing converts for a waiter gone.
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000
// A run past this is cut short, whatever it waits on (Redis, Mongo): its video
// fails as a timeout and its place goes to the next one.
const RUN_DEADLINE_MS = CONVERT_TIMEOUT_MS + 2 * 60 * 1000
// One look at the queue (a job, its state, the counts) gives up after this.
const QUEUE_LOOK_MS = 5 * 1000
// A tick whose database calls never answer lets the next one try.
const TICK_DEADLINE_MS = 60 * 1000
// Studio stops waiting on a video nobody took in this long (fstikbot-api
// utils/studio/video.js QUEUE_WAIT_MS; keep the two in step): such a video
// fails as a timeout instead of converting for nobody, ahead of fresh ones.
const QUEUE_WAIT_MS = 15 * 60 * 1000
// While a conversion runs, its process renews the claim this often...
const HEARTBEAT_MS = 20 * 1000
// ...so a claim not renewed for this long is a dead process's (a deploy
// restarts the bot): its video is taken again within a minute, and the new
// process waits on the same job (jobId) rather than converting it again.
const CLAIM_STALE_MS = 60 * 1000
// A video that killed or outlived two claims is not tried a third time.
const MAX_ATTEMPTS = 2
// Conversions one process waits on at once; the converter's own workers and
// the queue's priorities decide what actually runs.
const MAX_IN_FLIGHT = parseInt(process.env.STUDIO_VIDEO_IN_FLIGHT, 10) || 10
// A finished job stays in Redis this long, so a process that took the video
// over after a restart can still read its result.
const KEEP_JOB_S = 600

const OUTCOME_ERROR = { disabled: 'unavailable', timeout: 'timeout', enqueue: 'convert', failed: 'convert' }

const EXPIRED = Symbol('expired')

// `promise`, or `fallback` once `ms` pass; the timer is always cleared.
async function within (promise, ms, fallback) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback) })

  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

function mongoRepo (db) {
  return {
    claim: (now, staleBefore, queuedAfter) => db.StudioVideo.findOneAndUpdate(
      {
        $or: [
          { status: 'queued', createdAt: { $gte: queuedAfter } },
          { status: 'converting', claimedAt: { $lt: staleBefore } }
        ]
      },
      { $set: { status: 'converting', claimedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
      // The file stays in the database: the converter fetches it by link.
      { sort: { createdAt: 1 }, new: true, projection: { source: 0, result: 0 } }
    ).lean(),
    // Videos still queued since before `queuedAfter`: Studio gave up on them.
    expire: (queuedAfter, at) => db.StudioVideo.updateMany(
      { status: 'queued', createdAt: { $lt: queuedAfter } },
      { $set: { status: 'failed', error: 'timeout', updatedAt: at }, $unset: { source: 1, sourceKey: 1, sourceUrl: 1 } }
    ).then((result) => result.modifiedCount),
    findUser: (telegramId) => db.User.findOne({ telegram_id: telegramId }).select('_id locale').lean(),
    countVideoPacks: (owner) => db.StickerSet.countDocuments({ owner, video: true }),
    // Moves our own claim to `at`; false once another process has taken the video.
    renew: (video, at) => db.StudioVideo.updateOne(
      { _id: video._id, status: 'converting', claimedAt: video.claimedAt },
      { $set: { claimedAt: at, updatedAt: at } }
    ).then((result) => result.matchedCount > 0),
    // The job converting the video, on our own claim: in the queue until the converter starts it.
    setJob: (video, jobId) => db.StudioVideo.updateOne(
      { _id: video._id, status: 'converting', claimedAt: video.claimedAt },
      { $set: { jobId, waiting: true }, $unset: { startedAt: 1 } }
    ),
    // The converter started the job.
    started: (video, at) => db.StudioVideo.updateOne(
      { _id: video._id, status: 'converting', claimedAt: video.claimedAt },
      { $set: { startedAt: at }, $unset: { waiting: 1 } }
    ),
    // Only our own claim is settled; the source and its link go either way.
    settle: (video, set) => db.StudioVideo.updateOne(
      { _id: video._id, status: 'converting', claimedAt: video.claimedAt },
      { $set: { ...set, updatedAt: new Date() }, $unset: { source: 1, sourceKey: 1, sourceUrl: 1 } }
    )
  }
}

// Since the row was made (the tap in Studio), when there is one.
const sinceCreated = (video, at) => (video.createdAt ? at - new Date(video.createdAt) : undefined)

// One studio_video line when the converter starts a video and one when it
// ends: how long it waited in line, how long it converted, why it failed.
function logVideo (claim, status, at, extra = {}) {
  const { video } = claim
  logEvent('studio_video', `video ${status}${extra.error ? `: ${extra.error}` : ''}`, {
    level: status === 'failed' ? 'warn' : 'info',
    fields: {
      status,
      videoId: String(video._id),
      packType: video.packType,
      boost: video.boost || undefined,
      attempt: video.attempts,
      waitMs: claim.startedAt ? sinceCreated(video, claim.startedAt) : undefined,
      convertMs: claim.startedAt && status !== 'started' ? at - claim.startedAt : undefined,
      totalMs: status !== 'started' ? sinceCreated(video, at) : undefined,
      uid: logUid(video.telegramId),
      ...extra
    }
  })
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
 * @param {Function} deps.followJob utils/queue-job.js followQueueJob
 * @param {Function} [deps.now]
 * @param {number} [deps.heartbeatMs]
 * @param {number} [deps.runDeadlineMs]
 * @param {number} [deps.queueLookMs]
 */
function createVideoConverter ({ repo, queue, runJob, followJob, now = () => new Date(), heartbeatMs = HEARTBEAT_MS, runDeadlineMs = RUN_DEADLINE_MS, queueLookMs = QUEUE_LOOK_MS }) {
  let timer = null
  let ticking = null
  let stopping = false
  let listening = false
  const inFlight = new Set()
  // Job id → the claim waiting on it, for the queue's "active" events.
  const byJob = new Map()

  // A claim's renewals and its settle go one after another, so a settle always
  // names the claimedAt the row has; once the claim is lost, nothing is written.
  const write = (claim, fn) => {
    const next = claim.chain.then(() => (claim.lost ? null : fn()))
    // A failed write (Mongo hiccup) must not block the ones after it.
    claim.chain = next.catch(() => {})
    return next
  }

  // Past its deadline a run settles nothing more: the timeout was its outcome.
  const settle = (claim, set) => (claim.expired ? Promise.resolve() : write(claim, () => repo.settle(claim.video, set)))
  const fail = (claim, error) => {
    if (claim.expired) return Promise.resolve()
    if (!claim.lost) logVideo(claim, 'failed', now(), { error })
    return settle(claim, { status: 'failed', error })
  }

  const renew = (claim) => write(claim, async () => {
    const at = now()

    if (await repo.renew(claim.video, at)) {
      claim.video.claimedAt = at
      return
    }
    // Another process took the video (this one stalled past CLAIM_STALE_MS):
    // its conversion counts, this one's result is dropped.
    claim.lost = true
    clearInterval(claim.heartbeat)
    log.warn(`video ${claim.video._id}: claim lost`)
  })

  // Once per claim: the converter took the job off the queue.
  const markStarted = (claim) => {
    if (claim.started) return
    claim.started = true
    claim.startedAt = now()
    logVideo(claim, 'started', claim.startedAt)
    write(claim, () => repo.started(claim.video, claim.startedAt)).catch((err) => log.warn(`video ${claim.video._id}: started not saved:`, err.message))
  }

  // An "active" event can come before the job is known here, or be missed
  // (Redis reconnect): the job's own state is read on watching and on each
  // heartbeat until it starts. Nothing waits on it: a state Redis does not
  // give in time is read again on the next heartbeat.
  async function checkStarted (claim) {
    if (claim.started || claim.checking || !claim.job?.getState) return
    claim.checking = true
    try {
      const state = await within(claim.job.getState(), queueLookMs, null).catch(() => null)
      if (state === 'active') markStarted(claim)
    } finally {
      claim.checking = false
    }
  }

  function watchJob (claim, job) {
    claim.job = job
    byJob.set(String(job.id), claim)
    checkStarted(claim)
  }

  /** The convert queue says a job started (Bull's global:active, from any process). */
  function jobActive (jobId) {
    const claim = byJob.get(String(jobId))
    if (claim) markStarted(claim)
  }

  // The video's job: the one an earlier claim started, while Redis still has
  // it (after a restart), else a new one, whose id goes on the row at once.
  async function attach (claim) {
    const { video } = claim
    const known = video.jobId ? await within(queue.getJob(video.jobId), queueLookMs, null).catch(() => null) : null

    if (known) {
      watchJob(claim, known)
      return followJob(queue, known, { timeoutMs: CONVERT_TIMEOUT_MS })
    }

    const isEmoji = video.packType === 'custom_emoji'
    const user = await repo.findUser(video.telegramId)
    const owner = { videoPacks: user ? await repo.countVideoPacks(user._id) : 0, locale: user?.locale, boost: video.boost }

    const counts = await within(queue.getJobCounts(), queueLookMs, { waiting: 0 }).catch(() => ({ waiting: 0 }))
    if (queueTooBusy(counts.waiting, convertRank(owner))) return { busy: true }

    // The job the chat sends, minus `input`: the same frame, crop and length.
    return runJob(queue, {
      fileUrl: video.sourceUrl,
      timestamp: Date.now(),
      isEmoji,
      frameType: video.frameType || 'square',
      forceCrop: isEmoji,
      maxDuration: maxVideoDuration(video.boost),
      maxAgeMs: CONVERT_TIMEOUT_MS
    }, {
      priority: convertPriority(owner),
      timeoutMs: CONVERT_TIMEOUT_MS,
      keepSeconds: KEEP_JOB_S,
      onQueued: async (job) => {
        await write(claim, () => repo.setJob(video, String(job.id)))
        watchJob(claim, job)
      }
    })
  }

  async function convert (claim) {
    const { video } = claim

    if ((video.attempts || 0) > MAX_ATTEMPTS) return fail(claim, 'timeout')
    if (queue.disabled) return fail(claim, 'unavailable')

    const outcome = await attach(claim)

    if (outcome.busy) return fail(claim, 'busy')
    if (outcome.error) {
      log.warn(`video ${video._id}: ${outcome.error}`, outcome.cause?.message || '')
      // Waited too long in the converter's queue: load, not the video.
      if (outcome.error === 'failed' && isTooOld(outcome.cause?.message)) return fail(claim, 'timeout')
      return fail(claim, OUTCOME_ERROR[outcome.error] || 'convert')
    }

    if (claim.expired) return

    const result = Buffer.from(outcome.result.content, 'base64')
    const { width, height } = videoSize(outcome.result.metadata)

    await settle(claim, { status: 'done', result, size: result.length, width, height })
    if (claim.expired) return
    if (!claim.lost) logVideo(claim, 'done', now(), { sizeKb: Math.round(result.length / 102.4) / 10 })
    log.info(`video ${video._id}: ${result.length} B, ${width}x${height}`)
  }

  // A run with no outcome by its deadline (a Redis or Mongo call that never
  // answers) fails its video as a timeout and gives its place up at once. The
  // write is not waited on: if it hangs too, the claim, no longer renewed,
  // goes stale and another tick takes the video up again.
  function expire (claim) {
    log.warn(`video ${claim.video._id}: no outcome in ${runDeadlineMs} ms`)
    fail(claim, 'timeout').catch((err) => log.warn(`video ${claim.video._id}: timeout not saved:`, err.message))
    claim.expired = true
  }

  function track (video) {
    const claim = { video, lost: false, chain: Promise.resolve() }

    claim.heartbeat = setInterval(() => {
      renew(claim).catch((err) => log.warn(`video ${video._id}: renew failed:`, err.message))
      checkStarted(claim)
    }, heartbeatMs)
    claim.heartbeat.unref?.()

    let deadline
    const expired = new Promise((resolve) => { deadline = setTimeout(resolve, runDeadlineMs, EXPIRED) })
    deadline.unref?.()

    const converting = convert(claim)
      .catch(async (err) => {
        logError(err, { where: 'studio-video:convert' })
        await fail(claim, 'convert').catch(() => {})
      })

    const run = Promise.race([converting, expired])
      .then((outcome) => { if (outcome === EXPIRED) expire(claim) })
      .finally(() => {
        clearTimeout(deadline)
        clearInterval(claim.heartbeat)
        if (claim.job && byJob.get(String(claim.job.id)) === claim) byJob.delete(String(claim.job.id))
        inFlight.delete(run)
      })

    inFlight.add(run)
  }

  // Fails the videos Studio gave up on, then claims while there is room,
  // oldest first among the rest; each conversion is waited on apart.
  async function claimWhileRoom () {
    try {
      const at = now()
      const expired = await repo.expire(new Date(at.getTime() - QUEUE_WAIT_MS), at)
      if (expired) log.warn(`${expired} queued video(s) waited past ${QUEUE_WAIT_MS} ms: failed as timeout`)

      while (inFlight.size < MAX_IN_FLIGHT) {
        if (stopping) break
        const at = now()
        const video = await repo.claim(at, new Date(at.getTime() - CLAIM_STALE_MS), new Date(at.getTime() - QUEUE_WAIT_MS))
        if (!video) break
        track(video)
      }
    } catch (err) {
      logError(err, { where: 'studio-video:tick' })
    }
  }

  async function tick () {
    if (ticking || stopping) return
    // Cleared in a .finally, which always runs after this assignment. A
    // finally inside an async body with nothing to await (no room: all
    // MAX_IN_FLIGHT taken) ran before it, so `ticking` stayed set and no tick
    // claimed anything again until a restart.
    ticking = within(claimWhileRoom(), TICK_DEADLINE_MS).finally(() => { ticking = null })
    await ticking
  }

  /** Waits for every conversion started so far (tests, shutdown). */
  const settled = () => Promise.allSettled([...inFlight])

  function start () {
    if (!listening && queue.on) {
      listening = true
      queue.on('global:active', (jobId) => jobActive(jobId))
    }
    if (timer) return
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  // A conversion cut short here stops renewing its claim, so another process
  // takes the video once the claim goes stale.
  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (ticking) await ticking.catch(() => {})
  }

  return { start, stop, tick, settled, jobActive }
}

let instance = null

function getVideoConverter () {
  if (!instance) {
    const { db } = require('../database')
    const { convertQueue } = require('./queues')
    const { runQueueJob, followQueueJob } = require('./queue-job')
    instance = createVideoConverter({ repo: mongoRepo(db), queue: convertQueue, runJob: runQueueJob, followJob: followQueueJob })
  }
  return instance
}

module.exports = {
  CLAIM_STALE_MS,
  HEARTBEAT_MS,
  MAX_ATTEMPTS,
  MAX_IN_FLIGHT,
  QUEUE_WAIT_MS,
  createVideoConverter,
  mongoRepo,
  start: () => getVideoConverter().start(),
  stop: () => (instance ? instance.stop() : Promise.resolve())
}
