// Enqueue a Bull job and wait for its result — the "add, race against a
// timeout, handle a disabled queue" dance that photo-clear, video-round and
// the sticker remove-bg path each used to spell out slightly differently.
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
 * @param {Object} queue Bull queue (or the stub from utils/queues.js)
 * @param {Object} data job payload
 * @param {Object} options
 * @param {number} options.timeoutMs
 * @param {number} [options.priority=10]
 * @param {(job) => (void|Promise<void>)} [options.onQueued] runs right after
 *   the job is accepted, before waiting (e.g. to show a queue position)
 * @returns {Promise<{result: Object} | {error: 'disabled'|'enqueue'|'timeout'|'failed', cause?: Error}>}
 *   `result` always carries `content`; a job that finished without it counts
 *   as failed
 */
async function runQueueJob (queue, data, { timeoutMs, priority = 10, onQueued } = {}) {
  let job
  try {
    job = await queue.add(data, {
      priority,
      attempts: 1,
      removeOnComplete: true,
      // Failed jobs otherwise accumulate in Redis forever.
      removeOnFail: true
    })
  } catch (cause) {
    return { error: cause.code === 'QUEUE_DISABLED' ? 'disabled' : 'enqueue', cause }
  }

  if (onQueued) await Promise.resolve(onQueued(job)).catch(() => {})

  const outcome = await waitForJob(job, timeoutMs)
  if (outcome.result && !outcome.result.content) return { error: 'failed' }
  return outcome
}

module.exports = { runQueueJob, waitForJob }
