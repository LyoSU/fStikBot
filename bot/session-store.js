// Telegraf session middleware with pluggable backing store.
//
// Modes:
//   1. Redis-backed (REDIS_HOST set) — sessions persist across PM2 restarts
//      (every 6h) so users don't get kicked out of scenes mid-flow. 1h TTL
//      renewed on every write.
//   2. Memory-only (REDIS_HOST unset) — per-process Map, bounded size, LRU
//      eviction. Sessions reset on restart. Acceptable default when Redis
//      isn't provisioned; scenes are short-lived enough that 6h resets are
//      a minor UX hit but not a functional one.
//
// Redis is treated as a cache with a memory fallback, not as a hard
// dependency. If a connected Redis becomes unresponsive (stuck socket,
// server OOM, slow AUTH), operations time out and we flip to memory until
// the socket recovers. This is the only sane posture when the request path
// has a hard latency budget — the detach middleware will otherwise mask
// hangs and Telegram updates pile up silently.
//
// Why custom middleware instead of telegraf/session: two perf wins.
//   1. Dirty-check — telegraf/session always SETs on every update. We
//      serialize the session before/after the handler and skip the write
//      if nothing changed.
//   2. Strip userInfo — ctx.session.userInfo is a full Mongoose doc with
//      populated refs. updateUser rehydrates it fresh every request anyway,
//      so persisting it is pure waste (fat JSON, expensive stringify).
const Redis = require('ioredis')

const SESSION_PREFIX = 'session:'
const SESSION_TTL_SECONDS = 60 * 60 // 1 hour

// Redis is opt-in. Without a host the whole Redis path is skipped so we
// never connect to a wrong-or-stuck localhost:6379 that happens to accept
// TCP. This was the cause of the silent-handler incident — ioredis defaults
// host=localhost/port=6379 when env is unset, and something on the box
// accepted the connection but never answered commands.
const REDIS_ENABLED = !!process.env.REDIS_HOST

// Redis can be "connected" yet stop responding to commands. Without a
// per-op timeout every session lookup hangs forever; 500ms is well above
// normal Redis latency (<5ms) so it only trips on real stalls. Circuit
// breaker below flips redisHealthy=false after a timeout so we don't pay
// 500ms on every subsequent update while the socket recovers.
const REDIS_OP_TIMEOUT_MS = parseInt(process.env.REDIS_OP_TIMEOUT_MS, 10) || 500

// Memory fallback bounds.
const MEM_CLEANUP_MS = 2 * 60 * 1000
const MEM_TTL_MS = SESSION_TTL_SECONDS * 1000
const MEM_MAX_SIZE = 10000

const memoryFallback = new Map()
const memoryTimestamps = new Map()

let redis = null
let redisHealthy = false
let warnedDown = false

function withTimeout (promise, ms, label) {
  let t
  const timer = new Promise((resolve, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timer]).finally(() => clearTimeout(t))
}

if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 2,
      connectTimeout: 2000,
      // Reject commands instead of queueing them while disconnected — with
      // our memory fallback, failing fast is strictly better than waiting.
      enableOfflineQueue: false
    })
    redis.on('ready', () => {
      const wasDown = !redisHealthy
      redisHealthy = true
      if (wasDown && warnedDown) {
        console.log('[session-store] Redis back online')
        warnedDown = false
      } else if (wasDown) {
        console.log(`[session-store] Redis connected (${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379})`)
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
    redis = null
  }
} else {
  console.log('[session-store] REDIS_HOST not set — using in-memory sessions (reset on restart)')
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

function markUnhealthy (reason) {
  if (redisHealthy) {
    console.warn(`[session-store] Redis ${reason} — marking unhealthy, memory fallback`)
    warnedDown = true
  }
  redisHealthy = false
}

async function redisGet (key) {
  if (redis && redisHealthy) {
    let raw
    try {
      raw = await withTimeout(
        redis.get(SESSION_PREFIX + key),
        REDIS_OP_TIMEOUT_MS,
        `redis.get ${key}`
      )
    } catch (err) {
      if (err.message.includes('timed out')) markUnhealthy('GET timeout')
      else console.warn('[session-store] get failed, memory fallback:', err.message)
      memoryTimestamps.set(key, Date.now())
      return memoryFallback.get(key)
    }
    if (raw == null) return undefined
    try {
      return JSON.parse(raw)
    } catch (err) {
      // Corrupted value — treat as empty session, don't silently read stale
      // memory fallback (that would hide schema drift between deploys).
      console.warn('[session-store] corrupt JSON for key', key, '-', err.message)
      return undefined
    }
  }
  memoryTimestamps.set(key, Date.now())
  return memoryFallback.get(key)
}

async function redisSet (key, value) {
  if (value == null) return redisDel(key)
  if (redis && redisHealthy) {
    try {
      const raw = JSON.stringify(value)
      await withTimeout(
        redis.set(SESSION_PREFIX + key, raw, 'EX', SESSION_TTL_SECONDS),
        REDIS_OP_TIMEOUT_MS,
        `redis.set ${key}`
      )
      return
    } catch (err) {
      if (err.message.includes('timed out')) markUnhealthy('SET timeout')
      else console.warn('[session-store] set failed, memory fallback:', err.message)
      // fall through to memory
    }
  }
  memoryTimestamps.set(key, Date.now())
  memoryFallback.set(key, value)
}

async function redisDel (key) {
  if (redis && redisHealthy) {
    try {
      await withTimeout(
        redis.del(SESSION_PREFIX + key),
        REDIS_OP_TIMEOUT_MS,
        `redis.del ${key}`
      )
    } catch {
      // non-fatal — key-delete errors during outages don't need logging
    }
  }
  memoryTimestamps.delete(key)
  memoryFallback.delete(key)
}

// Indirection so tests can swap the storage layer without touching Redis.
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
// it guarantees the dirty check always trips and we SET on every update.
// Excluding it means SET only fires on real state changes.
function serializeForDirtyCheck (session) {
  if (!session || typeof session !== 'object') return JSON.stringify(session)
  const { userInfo, chainActions, ...rest } = session // eslint-disable-line no-unused-vars
  return JSON.stringify(rest)
}

// Legacy telegraf/session stored values as `{ session: {...}, expires: ts|null }`.
// New format is the raw session object. If the parsed value looks like the
// legacy wrapper, unwrap it. Conservative check to avoid mis-unwrapping an
// actual session that happens to contain a `session` field.
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
        const originalDirty = serializeForDirtyCheck(session)

        Object.defineProperty(ctx, 'session', {
          configurable: true,
          get: function () { return session },
          set: function (newValue) { session = { ...newValue } }
        })

        return Promise.resolve(next(ctx)).then(() => {
          const nextDirty = serializeForDirtyCheck(session)
          if (nextDirty === originalDirty) return
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
