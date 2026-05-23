const moment = require('moment')
const { db } = require('../database')
const log = require('../utils/logger').scope('broadcast:audiences')

// Registry of broadcast audiences. Each entry exposes:
//   - label:  human-readable name for the wizard inline keyboard
//   - count:  () => Promise<number>   — total recipients matching now
//   - cursor: () => MongooseCursor    — stream of { telegram_id } docs
//
// `count` is used at the confirmation step in the wizard. It can be expensive
// on big collections (countDocuments with $ne, or aggregation $lookup over
// stickersets), so it's wrapped in a small TTL cache + server-side maxTimeMS
// kill-switch. Adding a new audience = one entry here + a button in
// scenes/broadcast.js.

// User-document fields we project — _id is dropped because the recipient
// collection has its own _id, and storing the user's _id is wasted bytes.
const PROJECTION = { telegram_id: 1, _id: 0 }

// ───────────────────────────────────────────────────────────────────────
// Count cache
// ───────────────────────────────────────────────────────────────────────
// Wizard interactions cluster (operator picks audience A, glances, picks B,
// goes back, picks A again). Without caching, each pick re-runs a multi-
// second count. With a 5-minute TTL the operator pays the cost once per
// audience per session; everything else is instant. Bounded to one entry
// per audience key (~7 entries max), so no eviction needed.
const COUNT_CACHE_TTL_MS = parseInt(process.env.BROADCAST_COUNT_CACHE_TTL_MS, 10) || 5 * 60 * 1000
// Hard ceiling on count queries. Tells Mongo to abort instead of letting the
// connection's 30s socketTimeout silently kill it from the client side.
const COUNT_MAX_TIME_MS = parseInt(process.env.BROADCAST_COUNT_MAX_TIME_MS, 10) || 15000

const countCache = new Map()

const withCache = (key, computeFn) => async () => {
  const cached = countCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value

  const value = await computeFn()
  countCache.set(key, { value, expires: Date.now() + COUNT_CACHE_TTL_MS })
  return value
}

// ───────────────────────────────────────────────────────────────────────
// Simple find-based audiences
// ───────────────────────────────────────────────────────────────────────
const findAudience = (key, label, filterFn) => ({
  label,
  count: withCache(`count:${key}`, async () => {
    return db.User.countDocuments(filterFn()).maxTimeMS(COUNT_MAX_TIME_MS)
  }),
  cursor: () => db.User.find(filterFn()).select(PROJECTION).lean().cursor()
})

// ───────────────────────────────────────────────────────────────────────
// "Active with packs" audiences
// ───────────────────────────────────────────────────────────────────────
// Start from the StickerSet collection (indexed on `owner`) because that
// filter is far more selective than scanning every User. The same pipeline
// is reused for count (with $count) and for streaming (with $project).
const buildActivePipeline = (locale) => {
  const monthAgo = moment().subtract(1, 'month').toDate()
  const threeMonthsAgo = moment().subtract(3, 'months').toDate()

  const localeMatch = locale
    ? { 'user.locale': locale }
    : { 'user.locale': { $nin: ['en', 'ru', 'uk'] } }

  return [
    { $group: { _id: '$owner', packCount: { $sum: 1 } } },
    { $match: { packCount: { $gte: 2 } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    {
      $match: {
        'user.blocked': { $ne: true },
        'user.banned': { $ne: true },
        ...localeMatch,
        'user.updatedAt': { $gte: monthAgo },
        'user.createdAt': { $lte: threeMonthsAgo }
      }
    }
  ]
}

const activeAudience = (key, label, locale) => ({
  label,
  count: withCache(`count:${key}`, async () => {
    const res = await db.StickerSet
      .aggregate([...buildActivePipeline(locale), { $count: 'n' }])
      .allowDiskUse(true)
      .option({ maxTimeMS: COUNT_MAX_TIME_MS })
    return (res[0] && res[0].n) || 0
  }),
  cursor: () => db.StickerSet
    .aggregate([
      ...buildActivePipeline(locale),
      { $project: { _id: 0, telegram_id: '$user.telegram_id' } }
    ])
    .allowDiskUse(true)
    .cursor({ batchSize: 1000 })
})

// ───────────────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────────────
const AUDIENCES = {
  all: findAudience('all', '🌐 All users (excl. RU)',
    () => ({ blocked: { $ne: true }, locale: { $ne: 'ru' } })),
  ru: findAudience('ru', '🇷🇺 Russian (excl. premium)',
    () => ({ blocked: { $ne: true }, premium: { $ne: true }, locale: 'ru' })),
  uk: findAudience('uk', '🇺🇦 Ukrainian',
    () => ({ blocked: { $ne: true }, locale: 'uk' })),
  en: findAudience('en', '🇬🇧 English',
    () => ({ blocked: { $ne: true }, locale: 'en' })),
  other: findAudience('other', '🌐 Other locales',
    () => ({ blocked: { $ne: true }, banned: { $ne: true }, locale: { $nin: ['en', 'ru', 'uk'] } })),
  en_active: activeAudience('en_active', '🇬🇧 Active EN (≥2 packs)', 'en'),
  other_active: activeAudience('other_active', '🌐 Active other-lang (≥2 packs)', null)
}

const list = () => Object.entries(AUDIENCES).map(([key, { label }]) => ({ key, label }))

const get = (key) => AUDIENCES[key] || null

// Best-effort warmup: run all counts in the background at boot so the wizard
// is responsive on first use. Failures are logged but don't crash the boot.
// Worker calls this once via broadcast.startWorker().
const warmupCounts = () => {
  for (const [key, audience] of Object.entries(AUDIENCES)) {
    audience.count().catch((err) => {
      log.warn(`warmup count failed for ${key}: ${err.message}`)
    })
  }
}

// Expose for invalidation if needed (e.g. ad-hoc /admin "refresh counts").
const invalidateCache = () => countCache.clear()

module.exports = { AUDIENCES, list, get, warmupCounts, invalidateCache }
