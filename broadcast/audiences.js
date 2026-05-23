const moment = require('moment')
const { db } = require('../database')

// Registry of broadcast audiences. Each entry exposes:
//   - label:  human-readable name for the wizard inline keyboard
//   - count:  () => Promise<number>   — total recipients matching now
//   - cursor: () => MongooseCursor    — stream of { telegram_id } docs
//
// `count` is used at the confirmation step in the wizard.
// `cursor` is consumed once, at claim time, to materialize the
// BroadcastRecipient queue (see runner.materialize).
//
// Adding a new audience = one entry here + a button in scenes/broadcast-wizard.js.

// User-document fields we project — _id is dropped because the recipient
// collection has its own _id, and storing the user's _id is wasted bytes.
const PROJECTION = { telegram_id: 1, _id: 0 }

// Build a simple find-based audience from a filter factory.
const findAudience = (label, filterFn) => ({
  label,
  count: () => db.User.countDocuments(filterFn()),
  cursor: () => db.User.find(filterFn()).select(PROJECTION).lean().cursor()
})

// "Active with packs" audiences start from the StickerSet collection
// (indexed on owner) because that filter is far more selective than
// iterating every User and checking pack count via a lookup. The same
// pipeline is reused for count (with $count) and for streaming (with
// $project).
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

const activeAudience = (label, locale) => ({
  label,
  count: async () => {
    const res = await db.StickerSet
      .aggregate([...buildActivePipeline(locale), { $count: 'n' }])
      .allowDiskUse(true)
    return (res[0] && res[0].n) || 0
  },
  cursor: () => db.StickerSet
    .aggregate([
      ...buildActivePipeline(locale),
      { $project: { _id: 0, telegram_id: '$user.telegram_id' } }
    ])
    .allowDiskUse(true)
    .cursor({ batchSize: 1000 })
})

const AUDIENCES = {
  all: findAudience(
    '🌐 All users (excl. RU)',
    () => ({ blocked: { $ne: true }, locale: { $ne: 'ru' } })
  ),
  ru: findAudience(
    '🇷🇺 Russian (excl. premium)',
    () => ({ blocked: { $ne: true }, premium: { $ne: true }, locale: 'ru' })
  ),
  uk: findAudience(
    '🇺🇦 Ukrainian',
    () => ({ blocked: { $ne: true }, locale: 'uk' })
  ),
  en: findAudience(
    '🇬🇧 English',
    () => ({ blocked: { $ne: true }, locale: 'en' })
  ),
  other: findAudience(
    '🌐 Other locales',
    () => ({ blocked: { $ne: true }, banned: { $ne: true }, locale: { $nin: ['en', 'ru', 'uk'] } })
  ),
  en_active: activeAudience('🇬🇧 Active EN (≥2 packs)', 'en'),
  other_active: activeAudience('🌐 Active other-lang (≥2 packs)', null)
}

const list = () => Object.entries(AUDIENCES).map(([key, { label }]) => ({ key, label }))

const get = (key) => AUDIENCES[key] || null

module.exports = { AUDIENCES, list, get }
