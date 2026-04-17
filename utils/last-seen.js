// Throttled "last seen" tracker for User.updatedAt.
//
// Context: updateUser runs on every incoming update. Previously we set
// `user.updatedAt = new Date()` and then awaited `user.save()` — that's
// a full Mongoose save (validation + version bump + write) on every
// request, blocking the handler for ~7-10ms even when nothing else
// changed. With pool saturation it balloons to 50-150ms.
//
// But scenes/messaging.js relies on updatedAt to filter "users active
// in the last month" for broadcast campaigns, so we can't just drop it.
//
// Compromise: bump updatedAt via a fire-and-forget `updateOne` with
// `$currentDate`, throttled per-user so we fire at most once per hour.
// - No critical-path cost (fire-and-forget)
// - No full save (no validation, no populate rehydration)
// - updatedAt stays accurate enough for monthly activity windows
const THROTTLE_MS = parseInt(process.env.LAST_SEEN_THROTTLE_MS, 10) || 60 * 60 * 1000
const MAX_ENTRIES = parseInt(process.env.LAST_SEEN_MAX, 10) || 20000

const lastWrite = new Map()

function evictIfFull () {
  if (lastWrite.size < MAX_ENTRIES) return
  // LRU-ish: Map iterates in insertion order → oldest-first drop.
  const drop = Math.floor(MAX_ENTRIES * 0.1)
  const it = lastWrite.keys()
  for (let i = 0; i < drop; i++) {
    const k = it.next().value
    if (k === undefined) break
    lastWrite.delete(k)
  }
}

function touchLastSeen (User, userId) {
  if (!User || !userId) return
  const key = String(userId)
  const now = Date.now()
  const prev = lastWrite.get(key)
  if (prev && now - prev < THROTTLE_MS) return
  evictIfFull()
  lastWrite.set(key, now)
  User.updateOne({ _id: userId }, { $currentDate: { updatedAt: true } })
    .catch(err => console.error('[last-seen] updateOne failed:', err.message))
}

module.exports = {
  touchLastSeen,
  _cacheSize: () => lastWrite.size
}
