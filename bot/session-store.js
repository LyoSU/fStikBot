// In-memory Telegraf session.
//
// For a single-process bot (PM2, 6h restarts) Redis sessions were net
// negative: free-tier latency spikes, +1 network write per update, extra
// failure surface. Scenes are short-lived — losing state across a restart
// is the same UX as the bot briefly going offline.
//
// Redis is still used for multi-process state that genuinely needs
// persistence (broadcast campaigns — see utils/messaging.js).
const session = require('telegraf/session')

const SESSION_TTL_SECONDS = 60 * 60 // 1 hour — telegraf checks expires on read

function getSessionKey (ctx) {
  if ((ctx.from && ctx.chat && ctx.chat.id === ctx.from.id) || (!ctx.chat && ctx.from)) {
    return `user:${ctx.from.id}`
  }
  if (ctx.from && ctx.chat) {
    return `${ctx.from.id}:${ctx.chat.id}`
  }
  return undefined
}

// telegraf/session stores `{ session, expires }`; the default `new Map()`
// never evicts. Wrap it so idle keys get collected and the Map doesn't
// grow unbounded over a long-running process.
const MEM_MAX = 50000
const MEM_SWEEP_MS = 5 * 60 * 1000

function createMemoryStore () {
  const data = new Map()
  const interval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of data) {
      if (entry && entry.expires && entry.expires < now) data.delete(key)
    }
    if (data.size > MEM_MAX) {
      // Drop oldest entries by insertion order until under limit.
      const excess = data.size - MEM_MAX
      let i = 0
      for (const key of data.keys()) {
        if (i++ >= excess) break
        data.delete(key)
      }
    }
  }, MEM_SWEEP_MS)
  if (interval.unref) interval.unref()
  return data
}

const store = createMemoryStore()

function sessionMiddleware () {
  return session({ store, getSessionKey, ttl: SESSION_TTL_SECONDS })
}

module.exports = {
  sessionMiddleware,
  getSessionKey
}
