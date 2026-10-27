// Enqueue a Bull job and wait for its result — the "add, race against a
// timeout, handle a disabled queue" dance that photo-clear, video-round and
// the sticker remove-bg path each used to spell out slightly differently.
const { logError } = require('./error-line')
const { isTooOld, jobFields } = require('./video-convert-rules')

const TIMEOUT = Symbol('timeout')

/**
 * Wait for a job to finish, giving up after `timeoutMs`.
 *
 * The timeout resolves with a sentinel instead of rejecting: Promise.race
 * losers keep running, and a rejecting loser becomes an unhandled rejection
 * once the race is decided. The timer is always cleared.
 *
 * @returns {Promise<{result: Object} | {error: 'timeout'|'failed', cause?: Error}>}
 */
async function waitForJob (job, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })
  const finished = job.finished().then(
    (result) => ({ result }),
    (cause) => ({ error: 'failed', cause })
  )

  const outcome = await Promise.race([finished, timeout])
  clearTimeout(timer)

  if (outcome === TIMEOUT) return { error: 'timeout' }
  return outcome
}

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

module.exports = { runQueueJob, followQueueJob, waitForJob }
