// Telegraf session with an ioredis-backed store.
//
// Minimal wrapper — let ioredis handle retries/reconnects; no custom
// timeouts or circuit breakers. When REDIS_HOST is unset we fall back to
// an in-memory Map (sessions reset on restart, acceptable default).
//
// The only non-default tweak: strip ctx.session.userInfo before persisting.
// userInfo is a Mongoose doc with populated refs — updateUser rehydrates
// it fresh every request anyway, so persisting it is pure bloat.
const Redis = require('ioredis')
const session = require('telegraf/session')

const SESSION_PREFIX = 'session:'
const SESSION_TTL_SECONDS = 60 * 60 // 1 hour

const REDIS_ENABLED = !!process.env.REDIS_HOST

function createStore () {
  if (!REDIS_ENABLED) {
    console.log('[session-store] REDIS_HOST not set — using in-memory sessions (reset on restart)')
    return new Map()
  }

  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
    password: process.env.REDIS_PASSWORD || undefined
  })

  redis.on('connect', () => console.log(`[session-store] Redis connected (${process.env.REDIS_HOST})`))
  redis.on('error', (err) => console.warn('[session-store] Redis error:', err.message))

  return {
    async get (key) {
      const raw = await redis.get(SESSION_PREFIX + key)
      if (!raw) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    async set (key, value) {
      if (value == null) {
        await redis.del(SESSION_PREFIX + key)
        return
      }
      // Strip userInfo (Mongoose doc, rehydrated per-request).
      let stripped = value
      if (value && value.session && value.session.userInfo) {
        const { userInfo, ...rest } = value.session // eslint-disable-line no-unused-vars
        stripped = { ...value, session: rest }
      }
      await redis.set(SESSION_PREFIX + key, JSON.stringify(stripped), 'EX', SESSION_TTL_SECONDS)
    }
  }
}

function getSessionKey (ctx) {
  if ((ctx.from && ctx.chat && ctx.chat.id === ctx.from.id) || (!ctx.chat && ctx.from)) {
    return `user:${ctx.from.id}`
  }
  if (ctx.from && ctx.chat) {
    return `${ctx.from.id}:${ctx.chat.id}`
  }
  return undefined
}

const store = createStore()

function sessionMiddleware () {
  return session({ store, getSessionKey, ttl: SESSION_TTL_SECONDS })
}

module.exports = {
  sessionMiddleware,
  getSessionKey
}
