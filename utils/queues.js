// Bull queue handles for offloaded background work.
//
// Redis is opt-in: when REDIS_HOST isn't set, queues become stubs that
// reject add() with a clear "not configured" error. This stops Bull from
// silently retrying a localhost connection forever and keeps the handler
// chain responsive — features that need queues (video convert, remove-bg,
// video notes) degrade visibly to users instead of hanging their updates.
const Queue = require('bull')

const REDIS_ENABLED = !!process.env.REDIS_HOST

const redisConfig = REDIS_ENABLED
  ? {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
      password: process.env.REDIS_PASSWORD || undefined
    }
  : null

// Stub that mimics the Bull queue surface we actually use:
// add, getWaiting, getJobCounts, getJob, on. Enqueue rejects loudly;
// introspection returns empty. Nothing silently succeeds — callers that
// depend on queue completion (video/removebg paths) will see a reply-level
// error in the user-facing flow instead of a stalled handler.
function makeStubQueue (name) {
  const err = () => {
    const e = new Error(`queue[${name}] disabled: REDIS_HOST not set`)
    e.code = 'QUEUE_DISABLED'
    return e
  }
  return {
    name,
    disabled: true,
    add: () => Promise.reject(err()),
    getWaiting: () => Promise.resolve([]),
    getJobCounts: () => Promise.resolve({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getJob: () => Promise.resolve(null),
    on: () => {},
    close: () => Promise.resolve()
  }
}

function makeRealQueue (name) {
  return new Queue(name, { redis: redisConfig })
}

const make = REDIS_ENABLED ? makeRealQueue : makeStubQueue

if (!REDIS_ENABLED) {
  console.log('[queues] REDIS_HOST not set — queues disabled (video/removebg features unavailable)')
}

const convertQueue = make('convert')
const removebgQueue = make('removebg')
const videoNoteQueue = make('videoNote')

module.exports = {
  convertQueue,
  removebgQueue,
  videoNoteQueue,
  redisConfig,
  REDIS_ENABLED
}
