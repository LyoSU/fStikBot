// One write per minute per user in the shared public demo pack (passcode
// "public") — adds, deletes and restores share the budget. Checked against the
// pack being acted on: keyed on the selected pack, the limit was skipped by
// anyone who deleted public stickers while their own pack was selected.
const WINDOW_MS = 60 * 1000

const lastWrite = new Map()

// Drop users whose window is over so the map stays small.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [userId, at] of lastWrite) {
    if (at <= cutoff) lastWrite.delete(userId)
  }
}, WINDOW_MS).unref()

// true — allowed, and the write is counted; false — over the limit.
const take = (userId, now = Date.now()) => {
  const last = lastWrite.get(userId)
  if (last !== undefined && now - last < WINDOW_MS) return false
  lastWrite.set(userId, now)
  return true
}

const isPublic = (pack) => pack?.passcode === 'public'

module.exports = { take, isPublic, WINDOW_MS, reset: () => lastWrite.clear() }
