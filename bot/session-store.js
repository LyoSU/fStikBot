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
// Redis can be "connected" yet stop responding to commands (stuck socket,
// server OOM, network black-hole). Without a timeout every session lookup
// hangs forever, and the detach middleware hides the hang. 500ms is well
// above normal Redis latency (<5ms) so it only trips on real stalls.
const REDIS_OP_TIMEOUT_MS = parseInt(process.env.REDIS_OP_TIMEOUT_MS, 10) || 500

function withTimeout (promise, ms, label) {
  let t
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timer]).finally(() => clearTimeout(t))
}

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
      raw = await withTimeout(redis.get(SESSION_PREFIX + key), REDIS_OP_TIMEOUT_MS, `redis.get ${key}`)
    } catch (err) {
      // On timeout: mark Redis unhealthy so subsequent calls skip the
      // network immediately instead of each waiting 500ms. The 'ready'
      // handler will flip healthy back on when the socket recovers.
      if (err.message.includes('timed out')) {
        redisHealthy = false
        console.warn('[session-store] get TIMEOUT — marking Redis unhealthy, memory fallback:', err.message)
      } else {
        console.warn('[session-store] get failed, memory fallback:', err.message)
      }
      memoryTimestamps.set(key, Date.now())
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
      await withTimeout(
        redis.set(SESSION_PREFIX + key, raw, 'EX', SESSION_TTL_SECONDS),
        REDIS_OP_TIMEOUT_MS,
        `redis.set ${key}`
      )
      return
    } catch (err) {
      if (err.message.includes('timed out')) {
        redisHealthy = false
        console.warn('[session-store] set TIMEOUT — marking Redis unhealthy, memory fallback:', err.message)
      } else {
        console.warn('[session-store] set failed, memory fallback:', err.message)
      }
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

// Serialize the session for the WRITE payload. Strips userInfo because it's
// a Mongoose doc with populated refs — expensive to stringify, and
// updateUser rehydrates it fresh on every request anyway.
function serializeWithoutUserInfo (session) {
  if (!session || typeof session !== 'object') return JSON.stringify(session)
  const { userInfo, ...rest } = session // eslint-disable-line no-unused-vars
  return JSON.stringify(rest)
}

// Serialize for the DIRTY CHECK. Additionally strips chainActions — that
// array is mutated on every single update (append + shift), so including
// it guarantees the dirty check always trips and we SET to Redis on every
// update. Excluding it means SET only fires when REAL session state
// changes (scene, userInfo flags set by handlers, etc.). chainActions
// still persists whenever a real write happens, so error-log context is
// only slightly stale instead of totally absent.
function serializeForDirtyCheck (session) {
  if (!session || typeof session !== 'object') return JSON.stringify(session)
  const { userInfo, chainActions, ...rest } = session // eslint-disable-line no-unused-vars
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
        // Snapshot for the dirty-check (strips chainActions + userInfo —
        // see serializeForDirtyCheck). Comparing this prevents the
        // chainActions push from triggering a write on every update.
        const originalDirty = serializeForDirtyCheck(session)

        Object.defineProperty(ctx, 'session', {
          configurable: true,
          get: function () { return session },
          set: function (newValue) { session = { ...newValue } }
        })

        return Promise.resolve(next(ctx)).then(() => {
          const nextDirty = serializeForDirtyCheck(session)
          if (nextDirty === originalDirty) return
          // Dirty — write the FULL payload (with chainActions, sans userInfo)
          // so persisted error context stays in sync with real state changes.
          const nextSerialized = serializeWithoutUserInfo(session)
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
