// Per-user concurrency gate for the fire-and-forget sticker-add flow.
//
// Why: after detaching addSticker from the Telegraf handler (see
// handlers/sticker.js), the handler returns immediately and the heavy
// work (file download + uploadStickerFile + addStickerToSet) runs in
// the background. Without a cap, one user sending 20 stickers fast
// spawns 20 parallel in-flight chains — each hitting the pack's per-
// user rate limit on addStickerToSet, duplicating Telegram bandwidth
// and amplifying load for no benefit (Telegram will 429 anyway).
//
// Small cap (default 2) mirrors Telegram's own tolerance: two in flight
// is enough to overlap network latency; more just queues up 429s.
// Boosted packs are wired through the same cap — if they ever need a
// higher limit we can differentiate via the isBoost arg.

const MAX_PER_USER = parseInt(process.env.STICKER_INFLIGHT_PER_USER, 10) || 2

const counts = new Map()

function acquire (userId) {
  if (!userId) return true // no-op for anonymous (shouldn't happen, but defensive)
  const current = counts.get(userId) || 0
  if (current >= MAX_PER_USER) return false
  counts.set(userId, current + 1)
  return true
}

function release (userId) {
  if (!userId) return
  const current = counts.get(userId) || 0
  if (current <= 1) counts.delete(userId)
  else counts.set(userId, current - 1)
}

module.exports = {
  acquire,
  release,
  _size: () => counts.size,
  MAX_PER_USER
}
