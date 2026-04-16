// Redis-backed Telegraf session store with automatic in-memory fallback.
//
// Why Redis: PM2 restarts the process every 6h (ecosystem.config.js) which
// wiped in-memory sessions and kicked users out of scenes mid-flow. Redis
// persists across restarts and gives us TTL-based expiry for free.
//
// Why fallback: Redis outages should not take the whole bot down — sessions
// degrade to per-process memory until Redis recovers. Warned once on first
// failure, once on recovery.
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

async function get (key) {
  if (redisHealthy) {
    try {
      const raw = await redis.get(SESSION_PREFIX + key)
      if (raw == null) return undefined
      return JSON.parse(raw)
    } catch (err) {
      console.warn('[session-store] get failed, memory fallback:', err.message)
    }
  }
  memoryTimestamps.set(key, Date.now())
  return memoryFallback.get(key)
}

async function set (key, value) {
  if (value == null) return del(key)
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

async function del (key) {
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

// Session-key helper. Private chat → user-scoped; group → user+chat-scoped.
// Anonymous updates (no `from`) return undefined so Telegraf skips session
// entirely — previously these stored orphan entries keyed by update_id that
// never expired.
function getSessionKey (ctx) {
  if ((ctx.from && ctx.chat && ctx.chat.id === ctx.from.id) || (!ctx.chat && ctx.from)) {
    return `user:${ctx.from.id}`
  }
  if (ctx.from && ctx.chat) {
    return `${ctx.from.id}:${ctx.chat.id}`
  }
  return undefined
}

module.exports = {
  store: { get, set, delete: del },
  getSessionKey
}
