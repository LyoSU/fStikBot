const os = require('os')
const { db } = require('../database')
const log = require('../utils/logger').scope('broadcast:worker')
const { runBroadcast, cleanupRecipients } = require('./runner')
const { STATUS } = require('./status')

// Single-process worker. One tick claims at most one broadcast; while it's
// running, subsequent ticks short-circuit. Multiple campaigns are processed
// sequentially — they share the global rate-limiter anyway, so parallel
// dispatch would just mean fighting for the same 25 msg/s budget.

const TICK_INTERVAL_MS = parseInt(process.env.BROADCAST_TICK_INTERVAL_MS, 10) || 5000
const LOCK_TTL_MS = parseInt(process.env.BROADCAST_LOCK_TTL_MS, 10) || 5 * 60 * 1000
const LOCK_RENEW_MS = parseInt(process.env.BROADCAST_LOCK_RENEW_MS, 10) || 2 * 60 * 1000

// Process identifier for lock auditing. Includes hostname + pid so we can
// trace which replica owns a lock at any moment from the DB alone.
const PROCESS_ID = `${os.hostname()}#${process.pid}`

let tickTimer = null
let activeRun = null // Promise of the in-flight runBroadcast, if any
let shuttingDown = false

// ───────────────────────────────────────────────────────────────────────
// Atomic claim — two attempts: a fresh queued broadcast, then a stale-lock
// takeover of one that was abandoned mid-send.
// ───────────────────────────────────────────────────────────────────────
const claimNext = async () => {
  const now = new Date()
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS)

  // Aggregation-pipeline update preserves the original startedAt across
  // resume-from-paused (paused → queued → claimed again): $ifNull keeps the
  // first value seen, while still setting it on the very first claim.
  const fresh = await db.Broadcast.findOneAndUpdate(
    {
      status: STATUS.QUEUED,
      scheduledAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }]
    },
    [{
      $set: {
        status: STATUS.SENDING,
        lockedBy: PROCESS_ID,
        lockedUntil,
        startedAt: { $ifNull: ['$startedAt', now] }
      }
    }],
    { sort: { scheduledAt: 1 }, new: true }
  )
  if (fresh) return fresh

  // Stale-lock takeover — keep startedAt as-is, just refresh the lock.
  return db.Broadcast.findOneAndUpdate(
    { status: STATUS.SENDING, lockedUntil: { $lt: now } },
    { $set: { lockedBy: PROCESS_ID, lockedUntil } },
    { sort: { startedAt: 1 }, new: true }
  )
}

// Lock renewal: while a broadcast is running, keep extending lockedUntil so
// another replica doesn't preempt us. Stopped automatically when runBroadcast
// resolves (either way).
const startLockRenewal = (broadcastId) => {
  return setInterval(async () => {
    try {
      await db.Broadcast.updateOne(
        { _id: broadcastId, lockedBy: PROCESS_ID },
        { $set: { lockedUntil: new Date(Date.now() + LOCK_TTL_MS) } }
      )
    } catch (err) {
      log.error('lock renewal failed:', err.message)
    }
  }, LOCK_RENEW_MS)
}

const releaseLock = (broadcastId) =>
  db.Broadcast.updateOne(
    { _id: broadcastId, lockedBy: PROCESS_ID },
    { $set: { lockedBy: null, lockedUntil: null } }
  ).catch((err) => log.error('lock release failed:', err.message))

// ───────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────
const tick = async () => {
  if (activeRun || shuttingDown) return
  let broadcast
  try {
    broadcast = await claimNext()
  } catch (err) {
    log.error('claim failed:', err.message)
    return
  }
  if (!broadcast) return

  const renewal = startLockRenewal(broadcast._id)

  activeRun = (async () => {
    try {
      await runBroadcast(broadcast)
    } catch (err) {
      log.error(`broadcast ${broadcast._id} crashed:`, err.stack || err.message)
      await db.Broadcast.updateOne(
        { _id: broadcast._id },
        { $set: { status: STATUS.FAILED, pausedReason: String(err.message || err).slice(0, 300) } }
      ).catch(() => {})
      // Mirror the cleanup runBroadcast does on graceful completion — failed
      // campaigns also shouldn't leave their materialized queue behind. The
      // TTL index on BroadcastRecipient catches this if the explicit delete
      // also fails.
      await cleanupRecipients(broadcast._id).catch(() => {})
    } finally {
      clearInterval(renewal)
      await releaseLock(broadcast._id)
      activeRun = null
    }
  })()
}

// ───────────────────────────────────────────────────────────────────────
// Public lifecycle
// ───────────────────────────────────────────────────────────────────────
const start = () => {
  if (tickTimer) return
  log.info(`worker started (process=${PROCESS_ID}, interval=${TICK_INTERVAL_MS}ms)`)
  tickTimer = setInterval(() => {
    tick().catch((err) => log.error('tick error:', err.message))
  }, TICK_INTERVAL_MS)
  // Don't pin the event loop open just for this housekeeping timer.
  tickTimer.unref()
}

// Graceful drain: stop accepting new claims, wait for the in-flight run to
// reach a checkpoint, release its lock. Called from SIGTERM/SIGINT.
const stop = async () => {
  if (shuttingDown) return
  shuttingDown = true
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (activeRun) {
    log.info('waiting for in-flight broadcast to drain...')
    await activeRun.catch(() => {})
  }
  log.info('worker stopped')
}

process.on('SIGTERM', () => { stop().catch(() => {}) })
process.on('SIGINT', () => { stop().catch(() => {}) })

module.exports = { start, stop, PROCESS_ID }
