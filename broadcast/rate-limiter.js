// Token-bucket-style rate limiter for outbound broadcast sends.
//
// Why not Bottleneck/p-limit: this is ~30 lines that does exactly what we
// need — serialize calls so they leave at most N times per second. No
// priorities, no clustering, no Redis backend. The broadcast worker is
// single-process by design (see broadcast/worker.js), so a per-process
// in-memory limiter is the correct boundary.
//
// Telegram's documented global bot send rate is ~30 msg/s. We default to
// 25/s to leave headroom for the bot's normal reply traffic, which goes
// through the same Telegram client and shares that global ceiling.

const DEFAULT_RATE_PER_SEC = parseInt(process.env.BROADCAST_RATE_PER_SEC, 10) || 25

class RateLimiter {
  constructor (ratePerSec = DEFAULT_RATE_PER_SEC) {
    if (ratePerSec <= 0) throw new Error('ratePerSec must be > 0')
    this.intervalMs = 1000 / ratePerSec
    this.nextAvailable = 0
  }

  // Resolves once it's this caller's turn. Concurrent callers serialize
  // through the shared `nextAvailable` cursor — each reserves its slot
  // synchronously, then awaits the actual delay.
  async acquire () {
    const now = Date.now()
    const scheduled = Math.max(now, this.nextAvailable)
    this.nextAvailable = scheduled + this.intervalMs
    const wait = scheduled - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  // Used by the runner when Telegram explicitly asks us to back off for
  // longer than our normal interval — pushes the cursor forward so all
  // pending acquirers are paced past the requested delay.
  cooldown (seconds) {
    if (!seconds || seconds <= 0) return
    const until = Date.now() + (seconds * 1000)
    if (until > this.nextAvailable) this.nextAvailable = until
  }
}

// Process-wide singleton — all broadcast sends share one cursor regardless
// of which campaign is active.
const shared = new RateLimiter()

module.exports = { RateLimiter, shared }
