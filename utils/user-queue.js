// Per-user FIFO for sticker adds.
//
// Files a user sends in a burst (an album, three GIFs in a row) used to be
// refused with "still processing the previous file" and silently lost. Now
// each file waits its turn: adds for one user run in the order they arrived,
// which also keeps the stickers in the pack in the order they were sent.
//
// A task declares how many tasks of this user may run alongside it — boosted
// packs get parallel adds, everyone else one at a time. The only refusal left
// is an abuse cap on how many files one user can have waiting.
const log = require('./logger').scope('user-queue')

const MAX_PENDING = parseInt(process.env.STICKER_QUEUE_PER_USER, 10) || 30

const queues = new Map()

function drain (userId, queue) {
  while (queue.waiting.length > 0 && queue.running < queue.waiting[0].concurrency) {
    const { task } = queue.waiting.shift()
    queue.running++

    Promise.resolve()
      .then(task)
      .catch((err) => log.error(`task failed for user ${userId}:`, err?.stack || err))
      .finally(() => {
        queue.running--
        if (queue.running === 0 && queue.waiting.length === 0) queues.delete(userId)
        else drain(userId, queue)
      })
  }
}

/**
 * Queue a task for a user.
 *
 * @param {number} userId
 * @param {() => Promise<void>} task runs once earlier tasks allow it
 * @param {Object} [options]
 * @param {number} [options.concurrency=1] tasks of this user allowed to run at
 *   the same time as this one
 * @returns {{started: boolean} | null} null when the user already has too many
 *   files waiting; `started` is false when the task had to wait its turn
 */
function enqueue (userId, task, { concurrency = 1 } = {}) {
  let queue = queues.get(userId)
  if (!queue) {
    queue = { running: 0, waiting: [] }
    queues.set(userId, queue)
  }

  if (queue.running + queue.waiting.length >= MAX_PENDING) return null

  const entry = { task, concurrency: Math.max(1, concurrency) }
  queue.waiting.push(entry)
  drain(userId, queue)

  return { started: !queue.waiting.includes(entry) }
}

module.exports = {
  enqueue,
  MAX_PENDING,
  _size: () => queues.size
}
