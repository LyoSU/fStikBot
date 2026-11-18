// Enqueue a Bull job and wait for its result — the "add, race against a
// timeout, handle a disabled queue" dance that photo-clear, video-round and
// the sticker remove-bg path each used to spell out slightly differently.
const { logError } = require('./error-line')
const { isTooOld, jobFields } = require('./video-convert-rules')

const TIMEOUT = Symbol('timeout')

// Waiting for a job without Bull's job.finished(). That one adds a
// global:completed and a global:failed listener plus a 5 s watchdog interval
// (a Redis call each tick) per wait, and drops them only when the job ends. A
// wait that timed out on a job that never ends here — removed on completion
// before the event arrived, stalled, an event lost in a pub/sub reconnect —
// kept all three for the life of the process: a lead for the heap growth
// that crashes the bot about once a day.
//
// Here each queue has one pair of listeners and a map of waiters by job id;
// a wait leaves the map when it settles or times out, whatever happens to
// the job.
const registries = new WeakMap()

const parseResult = (value) => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (_) {
    return undefined
  }
}

function registryOf (queue) {
  let waiters = registries.get(queue)
  if (waiters) return waiters
  waiters = new Map()
  registries.set(queue, waiters)

  const settle = (jobId, outcome) => {
    const set = waiters.get(String(jobId))
    if (!set) return
    waiters.delete(String(jobId))
    const value = outcome()
    for (const resolve of set) resolve(value)
  }
  // Parsed only when somebody waits: a converter result is megabytes of base64.
  queue.on('global:completed', (jobId, value) => settle(jobId, () => ({ result: parseResult(value) })))
  queue.on('global:failed', (jobId, reason) => settle(jobId, () => ({ error: 'failed', cause: new Error(reason) })))
  return waiters
}

// A job that ended before the wait began sends no more events: look it up.
async function settledAlready (queue, id) {
  const job = await queue.getJob(id)
  if (!job) return null
  if (await job.isCompleted()) return { result: job.returnvalue }
  if (await job.isFailed()) return { error: 'failed', cause: new Error(job.failedReason) }
  return null
}

/**
 * Wait for a job to finish, giving up after `timeoutMs`. Never rejects.
 *
 * @param {Object} job a Bull job (its `queue` is used)
 * @returns {Promise<{result: Object} | {error: 'timeout'|'failed', cause?: Error}>}
 */
async function waitForJob (job, timeoutMs) {
  const waiters = registryOf(job.queue)
  const id = String(job.id)

  let done
  const settled = new Promise((resolve) => { done = resolve })
  if (!waiters.has(id)) waiters.set(id, new Set())
  waiters.get(id).add(done)

  const timer = setTimeout(() => done(TIMEOUT), timeoutMs)
  // After subscribing, so an end between the two can't be missed.
  settledAlready(job.queue, id).then((outcome) => { if (outcome) done(outcome) }, () => {})

  try {
    const outcome = await settled
    return outcome === TIMEOUT ? { error: 'timeout' } : outcome
  } finally {
    clearTimeout(timer)
    const set = waiters.get(id)
    if (set) {
      set.delete(done)
      if (!set.size) waiters.delete(id)
    }
  }
}

/** Waits in progress across all queues, for the memory log. */
const pendingWaits = (...queues) => queues.reduce((sum, queue) => {
  const waiters = registries.get(queue)
  if (!waiters) return sum
  for (const set of waiters.values()) sum += set.size
  return sum
}, 0)

/**
 * Waits for a job already in the queue, added here or found again by its id
 * (a waiter that outlived a restart).
 *
 * @returns {Promise<{result: Object} | {error: 'timeout'|'failed', cause?: Error}>}
 *   `result` always carries `content`; a job that finished without it counts
 *   as failed
 */
async function followQueueJob (queue, job, { timeoutMs }) {
  const outcome = await waitForJob(job, timeoutMs)
  if (outcome.result && !outcome.result.content) return { error: 'failed' }
  // A worker that gave up or never answered; whoever waits handles the user.
  if (outcome.error) {
    // Waiting too long (here or in the converter's queue) is load, not a fault.
    const code = outcome.error === 'timeout' ? 'wait_timeout' : isTooOld(outcome.cause?.message) ? 'too_old' : 'failed'

    logError(outcome.cause || outcome.error, {
      kind: 'queue_failed',
      where: `queue:${queue.name}`,
      level: code === 'failed' ? 'error' : 'warn',
      fields: { outcome: outcome.error, code, ...jobFields(job) }
    })
  }
  return outcome
}

/**
 * @param {Object} queue Bull queue (or the stub from utils/queues.js)
 * @param {Object} data job payload
 * @param {Object} options
 * @param {number} options.timeoutMs
 * @param {number} [options.priority=10]
 * @param {number} [options.keepSeconds] keep the finished job (and its result)
 *   this long, for a waiter that comes back for it; by default it goes at once
 * @param {(job) => (void|Promise<void>)} [options.onQueued] runs right after
 *   the job is accepted, before waiting (e.g. to show a queue position)
 * @returns {Promise<{result: Object} | {error: 'disabled'|'enqueue'|'timeout'|'failed', cause?: Error}>}
 */
async function runQueueJob (queue, data, { timeoutMs, priority = 10, keepSeconds, onQueued } = {}) {
  // Failed jobs otherwise accumulate in Redis forever.
  const keep = keepSeconds ? { age: keepSeconds } : true

  let job
  try {
    job = await queue.add(data, {
      priority,
      attempts: 1,
      removeOnComplete: keep,
      removeOnFail: keep
    })
  } catch (cause) {
    return { error: cause.code === 'QUEUE_DISABLED' ? 'disabled' : 'enqueue', cause }
  }

  // Awaited before the wait: a caller cleans up what onQueued set up (a
  // progress message, its refresh timer) once the outcome is in.
  if (onQueued) await Promise.resolve(onQueued(job)).catch(() => {})

  return followQueueJob(queue, job, { timeoutMs })
}

module.exports = { runQueueJob, followQueueJob, waitForJob, pendingWaits }
