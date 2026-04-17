// Single source of truth for Redis configuration.
//
// All Redis consumers (Bull queues in utils/queues.js, broadcast worker
// in utils/messaging.js, admin scene in scenes/messaging.js) share the
// options defined here so timeouts, retry, and keepalive don't drift.
//
// Redis is opt-in via REDIS_HOST — when unset, callers get null and must
// degrade gracefully (stub queues, disabled broadcast UI). This prevents
// ioredis defaulting to localhost:6379 and hanging on a stuck socket.
const Redis = require('ioredis')

const REDIS_ENABLED = !!process.env.REDIS_HOST

// keepAlive=30s: OS-level TCP keepalive probes so hosted providers
// (Redis Cloud / Upstash free tiers) don't RST idle sockets after
// ~5min of quiet — that was showing up as "AbortError: Command aborted
// due to connection close" on the next pipeline batch.
//
// retryStrategy: exponential-ish backoff capped at 3s so short network
// blips recover quickly without hammering the server on long outages.
const redisConfig = REDIS_ENABLED
  ? {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      keepAlive: 30000,
      retryStrategy: (times) => Math.min(times * 200, 3000)
    }
  : null

function createRedisClient (name, overrides = {}) {
  if (!REDIS_ENABLED) return null
  const client = new Redis({ ...redisConfig, ...overrides })
  // Without an 'error' listener, ioredis throws the error out as an
  // unhandled event which can crash the process. A warn-level log is
  // enough — ioredis retries internally.
  client.on('error', (err) => {
    console.warn(`[redis:${name}] ${err.message}`)
  })
  return client
}

// Shared singleton for broadcast campaigns. Both the admin scene
// (scenes/messaging.js) and the worker loop (utils/messaging.js) use the
// same keyspace, so they can share a single connection. One client on
// the free-tier quota instead of two.
let broadcastClient = null
function getBroadcastClient () {
  if (!REDIS_ENABLED) return null
  if (!broadcastClient) broadcastClient = createRedisClient('broadcast')
  return broadcastClient
}

module.exports = {
  REDIS_ENABLED,
  redisConfig,
  createRedisClient,
  getBroadcastClient
}
