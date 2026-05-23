const { db } = require('../database')
const log = require('../utils/logger').scope('broadcast:runner')
const audiences = require('./audiences')
const { sendToRecipient } = require('./send')
const { shared: rateLimiter } = require('./rate-limiter')
const { classify, isSoftBan, isPauseTrigger, describe, CODE } = require('./errors')
const { STATUS } = require('./status')

// Tunables
const BATCH_SIZE = parseInt(process.env.BROADCAST_BATCH_SIZE, 10) || 100
const MATERIALIZE_BATCH = parseInt(process.env.BROADCAST_MATERIALIZE_BATCH, 10) || 5000
const ERROR_SAMPLES_PER_BATCH = 5 // how many error samples to push per batch
const ERROR_SAMPLES_MAX = 20 // cap total samples kept on the document
// Anything above this threshold is treated as "Telegram wants us to stop",
// not "wait briefly" — the runner pauses the campaign and notifies the
// creator instead of holding the rate limiter for minutes.
const PAUSE_RETRY_AFTER_S = parseInt(process.env.BROADCAST_PAUSE_RETRY_AFTER_S, 10) || 60

// ───────────────────────────────────────────────────────────────────────
// Materialization — runs once per broadcast, on first claim
// ───────────────────────────────────────────────────────────────────────
// Walks the audience cursor and bulk-inserts BroadcastRecipient rows. After
// this, the send loop iterates that collection by keyset on _id and is
// fully oblivious to the audience type.
const materialize = async (broadcast) => {
  const audience = audiences.get(broadcast.audience.type)
  if (!audience) throw new Error(`Unknown audience: ${broadcast.audience.type}`)

  log.info(`materializing broadcast ${broadcast._id} (audience=${broadcast.audience.type})`)

  // Quick count first → admins see "0 / N" immediately instead of "0 / 0"
  // while the cursor traversal runs. The post-walk update below corrects the
  // total to the actual number of inserted recipients (which can drift by a
  // few rows if users register/block during materialization).
  try {
    const estimate = await audience.count()
    await db.Broadcast.updateOne(
      { _id: broadcast._id },
      { $set: { 'progress.total': estimate } }
    )
    broadcast.progress.total = estimate
  } catch (err) {
    log.warn(`pre-materialize count failed for ${broadcast._id}: ${err.message}`)
  }

  const cursor = audience.cursor()
  let buffer = []
  let total = 0

  const flush = async () => {
    if (!buffer.length) return
    await db.BroadcastRecipient.insertMany(buffer, { ordered: false })
    buffer = []
  }

  for await (const doc of cursor) {
    if (!doc || !doc.telegram_id) continue
    buffer.push({ broadcastId: broadcast._id, telegram_id: doc.telegram_id })
    total++
    if (buffer.length >= MATERIALIZE_BATCH) await flush()
  }
  await flush()

  await db.Broadcast.updateOne(
    { _id: broadcast._id },
    { $set: { 'progress.total': total, 'progress.materialized': true } }
  )

  broadcast.progress.total = total
  broadcast.progress.materialized = true

  // Audience drift check: warn loudly if the actual recipient count diverges
  // by >5% from what the operator saw at confirm-time. Doesn't block dispatch
  // — the operator may have scheduled the campaign days ago and accept drift.
  const snapshot = broadcast.audience && broadcast.audience.snapshotCount
  if (snapshot && Math.abs(total - snapshot) / snapshot > 0.05) {
    log.warn(
      `broadcast ${broadcast._id} audience drift: snapshot=${snapshot} actual=${total} ` +
      `(${(((total - snapshot) / snapshot) * 100).toFixed(1)}%)`
    )
  }

  log.info(`materialized broadcast ${broadcast._id}: ${total} recipients`)
  return total
}

// ───────────────────────────────────────────────────────────────────────
// Per-batch dispatch
// ───────────────────────────────────────────────────────────────────────
const dispatchBatch = async (broadcast, recipients) => {
  return Promise.all(recipients.map(async (recipient) => {
    await rateLimiter.acquire()
    try {
      await sendToRecipient(broadcast, recipient.telegram_id)
      return { telegramId: recipient.telegram_id, ok: true }
    } catch (err) {
      return { telegramId: recipient.telegram_id, ok: false, err }
    }
  }))
}

// Identify the first error in the batch that should halt the campaign rather
// than be counted as a normal failure. Returns the index, or -1 if none.
const findPauseTriggerIdx = (results) => {
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.ok) continue
    const code = classify(r.err)
    if (isPauseTrigger(code)) return i
    const retryAfter = r.err && r.err.parameters && r.err.parameters.retry_after
    if (code === CODE.RATE_LIMIT && retryAfter > PAUSE_RETRY_AFTER_S) return i
  }
  return -1
}

const buildPauseReason = (err) => {
  const code = classify(err)
  if (code === CODE.RATE_LIMIT) {
    const retryAfter = err && err.parameters && err.parameters.retry_after
    return `Telegram rate limit: retry_after=${retryAfter}s`
  }
  return `${code}: ${describe(err)}`
}

// Convert raw send results into a single Mongo update + side effects:
//   - increment counters
//   - record up to N error samples (capped at ERROR_SAMPLES_MAX via $slice)
//   - flag unreachable users (bulk update on User.blocked)
//   - decide whether to pause the campaign (long 429 or invalid media)
//
// When pause is triggered mid-batch, results at/after the trigger index are
// NOT counted: they'll be retried on resume. The checkpoint `lastRecipientId`
// only advances past results that were definitively handled. Trade-off: a
// recipient who received the post but whose response was rate-limited will
// see a duplicate when resumed (at-least-once delivery > silent loss).
const applyBatchResults = async (broadcast, recipients, results) => {
  const pauseIdx = findPauseTriggerIdx(results)
  const processable = pauseIdx >= 0 ? results.slice(0, pauseIdx) : results
  const pauseReason = pauseIdx >= 0 ? buildPauseReason(results[pauseIdx].err) : null

  const inc = { 'progress.sent': 0, 'progress.failed': 0 }
  const samples = []
  const softBans = []

  for (const r of processable) {
    if (r.ok) {
      inc['progress.sent'] += 1
      continue
    }

    inc['progress.failed'] += 1
    const code = classify(r.err)
    inc[`errorCounts.${code}`] = (inc[`errorCounts.${code}`] || 0) + 1

    if (isSoftBan(code)) softBans.push(r.telegramId)

    if (code === CODE.RATE_LIMIT) {
      const retryAfter = r.err && r.err.parameters && r.err.parameters.retry_after
      // Short backoff that send.js couldn't absorb — cool the shared limiter
      // so subsequent batches breathe.
      if (retryAfter) rateLimiter.cooldown(retryAfter)
    }

    if (samples.length < ERROR_SAMPLES_PER_BATCH) {
      samples.push({
        telegram_id: r.telegramId,
        code,
        message: describe(r.err),
        at: new Date()
      })
    }
  }

  // Checkpoint advances only past results we definitively processed. If pause
  // hit at index 0, lastRecipientId stays unchanged — the whole batch retries.
  const checkpointIdx = (pauseIdx >= 0 ? pauseIdx : results.length) - 1
  const nextLastRecipientId = checkpointIdx >= 0
    ? recipients[checkpointIdx]._id
    : broadcast.progress.lastRecipientId

  const update = { $inc: inc, $set: {} }
  if (nextLastRecipientId) update.$set['progress.lastRecipientId'] = nextLastRecipientId
  if (samples.length) {
    update.$push = { errorSamples: { $each: samples, $slice: -ERROR_SAMPLES_MAX } }
  }
  if (pauseReason) {
    update.$set.status = STATUS.PAUSED
    update.$set.pausedReason = pauseReason
  }
  if (!Object.keys(update.$set).length) delete update.$set

  await db.Broadcast.updateOne({ _id: broadcast._id }, update)

  if (softBans.length) {
    await db.User.updateMany(
      { telegram_id: { $in: softBans } },
      { $set: { blocked: true } }
    ).catch((err) => log.error('failed to flag soft-banned users:', err.message))
  }

  return { pauseReason, nextLastRecipientId }
}

// ───────────────────────────────────────────────────────────────────────
// Main send loop
// ───────────────────────────────────────────────────────────────────────
const sendLoop = async (broadcast) => {
  let lastId = broadcast.progress.lastRecipientId

  while (true) {
    // Cheap status check — one indexed read per batch (100 sends).
    // Lets cancel/pause from the admin UI take effect within seconds.
    const fresh = await db.Broadcast.findById(broadcast._id).select('status').lean()
    if (!fresh) {
      log.warn(`broadcast ${broadcast._id} disappeared mid-flight`)
      return
    }
    if (fresh.status !== STATUS.SENDING) {
      log.info(`broadcast ${broadcast._id} stopped: status=${fresh.status}`)
      return
    }

    const filter = { broadcastId: broadcast._id }
    if (lastId) filter._id = { $gt: lastId }

    const recipients = await db.BroadcastRecipient
      .find(filter)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean()

    if (!recipients.length) return // drained → caller marks completed

    const results = await dispatchBatch(broadcast, recipients)
    const { pauseReason, nextLastRecipientId } = await applyBatchResults(broadcast, recipients, results)

    if (pauseReason) {
      log.warn(`broadcast ${broadcast._id} paused: ${pauseReason}`)
      return
    }

    // Mirror in-memory cursor with the persisted checkpoint, so subsequent
    // batches resume from the same place even if pause split the batch.
    lastId = nextLastRecipientId || lastId
  }
}

// ───────────────────────────────────────────────────────────────────────
// Public entry: run one broadcast end-to-end
// ───────────────────────────────────────────────────────────────────────
const runBroadcast = async (broadcast) => {
  log.info(`starting broadcast ${broadcast._id} "${broadcast.name}"`)

  if (!broadcast.progress.materialized) {
    await materialize(broadcast)
  }

  await sendLoop(broadcast)

  // Re-read terminal status: sendLoop may have set paused/cancelled.
  const finalDoc = await db.Broadcast.findById(broadcast._id).select('status progress').lean()
  if (!finalDoc) return

  if (finalDoc.status === STATUS.SENDING) {
    // Drained the queue without any pause/cancel — mark completed and clean up.
    await db.Broadcast.updateOne(
      { _id: broadcast._id },
      { $set: { status: STATUS.COMPLETED, completedAt: new Date() } }
    )
    await db.BroadcastRecipient.deleteMany({ broadcastId: broadcast._id })
    log.info(`broadcast ${broadcast._id} completed: ${finalDoc.progress.sent}/${finalDoc.progress.total}`)
  }
}

// Cleanup recipients for any non-running broadcast. Called when an operator
// cancels a campaign — runner exits naturally on next status poll, but the
// materialized queue would linger otherwise.
const cleanupRecipients = (broadcastId) =>
  db.BroadcastRecipient.deleteMany({ broadcastId })

module.exports = { runBroadcast, materialize, cleanupRecipients }
