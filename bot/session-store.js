// Redis-backed Telegraf session middleware with automatic in-memory fallback.
//
// Why Redis: PM2 restarts the process every 6h (ecosystem.config.js) which
// wiped in-memory sessions and kicked users out of scenes mid-flow. Redis
// persists across restarts and gives us TTL-based expiry for free.
//
// Why fallback: Redis outages should not take the whole bot down — sessions
// degrade to per-process memory until Redis recovers. Warned once on first
// failure, once on recovery.
//
// Why custom middleware instead of telegraf/session: two perf wins.
//   1. Dirty-check — telegraf/session always SETs on every update. We
//      serialize the session before/after the handler and skip the write
//      if nothing changed.
//   2. Strip userInfo — ctx.session.userInfo is a full Mongoose doc with
//      populated refs. updateUser rehydrates it fresh every request anyway,
//      so persisting it is pure waste (fat JSON, expensive stringify).
const Redis = require('ioredis')
const { redisConfig } = require('../utils/queues')

const SESSION_PREFIX = 'session:'
const SESSION_TTL_SECONDS = 60 * 60 // 1 hour

// Fallback cache — only used while Redis is unreachable
const memoryFallback = new Map()
const memoryTimestamps = new Map()
const MEM_CLEANUP_MS = 2 * 60 * 1000
const MEM_TTL_MS = SESSION_TTL_SECONDS * 1000
const MEM_MAX_SIZE = 10000

let redis = null
let redisHealthy = false
let warnedDown = false

try {
  redis = new Redis({
    ...redisConfig,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false
  })
  redis.on('ready', () => {
    const wasDown = !redisHealthy
    redisHealthy = true
    if (wasDown && warnedDown) {
      console.log('[session-store] Redis back online')
      warnedDown = false
    }
  })
  redis.on('error', (err) => {
    if (redisHealthy || !warnedDown) {
      console.warn('[session-store] Redis unhealthy, falling back to memory:', err.message)
      warnedDown = true
    }
    redisHealthy = false
  })
  redis.on('end', () => {
    redisHealthy = false
  })
} catch (err) {
  console.warn('[session-store] Redis init failed, using memory-only store:', err.message)
}

// Periodic memory cleanup. unref so it doesn't keep the process alive.
const cleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, ts] of memoryTimestamps) {
    if (now - ts > MEM_TTL_MS) {
      memoryFallback.delete(key)
      memoryTimestamps.delete(key)
    }
  }
  if (memoryFallback.size > MEM_MAX_SIZE) {
    const excess = memoryFallback.size - MEM_MAX_SIZE
    const sorted = [...memoryTimestamps.entries()].sort((a, b) => a[1] - b[1])
    for (let i = 0; i < excess && i < sorted.length; i++) {
      memoryFallback.delete(sorted[i][0])
      memoryTimestamps.delete(sorted[i][0])
    }
  }
}, MEM_CLEANUP_MS)
if (cleanupInterval.unref) cleanupInterval.unref()

async function redisGet (key) {
  if (redisHealthy) {
    let raw
    try {
      raw = await redis.get(SESSION_PREFIX + key)
    } catch (err) {
      console.warn('[session-store] get failed, memory fallback:', err.message)
      return memoryFallback.get(key)
    }
    if (raw == null) return undefined
    try {
      return JSON.parse(raw)
    } catch (err) {
      // Corrupted Redis value — treat as empty session (fresh start)
      // rather than silently falling through to stale memory fallback.
      console.warn('[session-store] corrupt JSON for key', key, '-', err.message)
      return undefined
    }
  }
  memoryTimestamps.set(key, Date.now())
  return memoryFallback.get(key)
}

async function redisSet (key, value) {
  if (value == null) return redisDel(key)
  if (redisHealthy) {
    try {
      const raw = JSON.stringify(value)
      await redis.set(SESSION_PREFIX + key, raw, 'EX', SESSION_TTL_SECONDS)
      return
    } catch (err) {
      console.warn('[session-store] set failed, memory fallback:', err.message)
    }
  }
  memoryTimestamps.set(key, Date.now())
  memoryFallback.set(key, value)
}

async function redisDel (key) {
  if (redisHealthy) {
    try {
      await redis.del(SESSION_PREFIX + key)
    } catch {
      // ignore — key-delete errors during outages are non-fatal
    }
  }
  memoryTimestamps.delete(key)
  memoryFallback.delete(key)
}

// Indirection so tests can swap the storage layer without touching Redis.
// Production just points these at the real implementations above. Tests
// override via _internal.setImpl.
const storage = {
  get: redisGet,
  set: redisSet,
  del: redisDel
}

// Session-key helper. Private chat → user-scoped; group → user+chat-scoped.
// Anonymous updates (no `from`) return undefined so the middleware skips
// session entirely — previously these stored orphan entries keyed by
// update_id that never expired.
function getSessionKey (ctx) {
  if ((ctx.from && ctx.chat && ctx.chat.id === ctx.from.id) || (!ctx.chat && ctx.from)) {
    return `user:${ctx.from.id}`
  }
  if (ctx.from && ctx.chat) {
    return `${ctx.from.id}:${ctx.chat.id}`
  }
  return undefined
}

// Serialize the session minus userInfo. Used both for the dirty-check and
// for the actual persisted payload. Returning the string directly means we
// can compare it literally (no crypto needed) and reuse it for writes.
function serializeWithoutUserInfo (session) {
  if (!session || typeof session !== 'object') return JSON.stringify(session)
  // Shallow copy, drop userInfo. userInfo is a Mongoose doc + populated refs
  // so stringifying it is expensive and pointless — updateUser rehydrates it
  // fresh on every request.
  const { userInfo, ...rest } = session // eslint-disable-line no-unused-vars
  return JSON.stringify(rest)
}

// Legacy telegraf/session stored values as `{ session: {...}, expires: ts|null }`.
// New format is the raw session object. If the parsed value looks like the
// legacy wrapper (has `session` + only session/expires top-level keys),
// unwrap it. Otherwise return as-is. Conservative check to avoid
// mis-unwrapping an actual session that happens to contain a `session` field.
function unwrapLegacy (parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed
  if (!Object.prototype.hasOwnProperty.call(parsed, 'session')) return parsed
  const keys = Object.keys(parsed)
  const onlyLegacyKeys = keys.every((k) => k === 'session' || k === 'expires')
  if (!onlyLegacyKeys) return parsed
  return parsed.session || {}
}

function sessionMiddleware () {
  return (ctx, next) => {
    const key = getSessionKey(ctx)
    if (!key) {
      // Anonymous update — no session work, don't even touch storage.
      return next(ctx)
    }
    return Promise.resolve(storage.get(key))
      .then((stored) => {
        let session = unwrapLegacy(stored) || {}
        // Snapshot for the dirty-check. Exclude userInfo — it's rehydrated
        // by updateUser every request and we deliberately never persist it.
        const originalSerialized = serializeWithoutUserInfo(session)

        Object.defineProperty(ctx, 'session', {
          configurable: true,
          get: function () { return session },
          set: function (newValue) { session = { ...newValue } }
        })

        return Promise.resolve(next(ctx)).then(() => {
          const nextSerialized = serializeWithoutUserInfo(session)
          if (nextSerialized === originalSerialized) return
          // nextSerialized is already JSON of the session sans userInfo.
          // Parse it back so storage.set stringifies consistently with how
          // storage.get parses, and so the memory fallback holds an object.
          const payload = nextSerialized === 'undefined' ? undefined : JSON.parse(nextSerialized)
          return storage.set(key, payload)
        })
      })
  }
}

module.exports = {
  sessionMiddleware,
  getSessionKey,
  _internal: {
    // Test hatch — swap the storage backend to avoid Redis in unit tests.
    setImpl (impl) {
      if (impl.get) storage.get = impl.get
      if (impl.set) storage.set = impl.set
      if (impl.del) storage.del = impl.del
    },
    resetImpl () {
      storage.get = redisGet
      storage.set = redisSet
      storage.del = redisDel
    },
    serializeWithoutUserInfo,
    unwrapLegacy,
    storage
  }
}
