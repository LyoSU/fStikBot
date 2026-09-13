// Product counters — how many people start /new and finish it, how many adds
// succeed, why the rest fail. Counted in memory and written once a minute as
// $inc on the day's document, so tracking never adds a query to a request.
const { db } = require('../database')
const log = require('./logger').scope('metrics')

const FLUSH_MS = 60 * 1000

const pending = new Map()

const today = () => new Date().toISOString().slice(0, 10)

// Mongo field names can't contain "." or start with "$".
const safeName = (name) => String(name).replace(/[.$]/g, '_')

/**
 * @param {string} name event name, e.g. "sticker.added" style names are
 *   stored as "sticker_added"
 * @param {number} [count=1]
 */
function track (name, count = 1) {
  const key = `${today()}|${safeName(name)}`
  pending.set(key, (pending.get(key) || 0) + count)
}

async function flush () {
  if (pending.size === 0) return

  const byDay = {}
  for (const [key, count] of pending) {
    const [day, name] = key.split('|')
    if (!byDay[day]) byDay[day] = {}
    byDay[day][`counts.${name}`] = count
  }
  pending.clear()

  await Promise.all(Object.entries(byDay).map(([day, inc]) =>
    db.Metric.updateOne({ _id: day }, { $inc: inc, $setOnInsert: { expireAt: new Date(`${day}T00:00:00Z`) } }, { upsert: true })
  )).catch((err) => log.error('flush failed:', err.message))
}

setInterval(() => { flush() }, FLUSH_MS).unref()

/**
 * The last `days` days, newest first: [{ day, counts }].
 */
async function recent (days = 7) {
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  await flush()
  const docs = await db.Metric.find({ _id: { $gte: since } }).sort({ _id: -1 }).lean()
  return docs.map((doc) => ({ day: doc._id, counts: doc.counts || {} }))
}

module.exports = { track, flush, recent }
