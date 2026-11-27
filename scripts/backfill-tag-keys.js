// One-off: bring the tags of packs published before utils/tag-normalize.js to
// what the catalogue scene now saves: `about.tags` cleaned, deduplicated and
// cut to 20 in the author's order, and `about.tagKeys` next to them.
//
// Dry run unless --apply. Reads the bot's database only (never Atlas: the
// catalogue copies `about.tags` when fstik-nsfw next syncs a pack, and never
// `tagKeys`). Writes go through the driver, so `updatedAt` stays as it was
// and no hooks run.
//
//   node scripts/backfill-tag-keys.js                 # dry run, prints what would change
//   node scripts/backfill-tag-keys.js --apply         # writes
//   node scripts/backfill-tag-keys.js --limit 5000    # stop after 5000 packs with tags
//   node scripts/backfill-tag-keys.js --apply --pause-ms 200 --batch 500
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { normalizeTags, MAX_TAGS } = require('../utils/tag-normalize')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? Number(process.argv[i + 1]) : fallback
}

const apply = process.argv.includes('--apply')
const BATCH = arg('batch', 1000)
const PAUSE_MS = arg('pause-ms', 100)
const LIMIT = arg('limit', Infinity)
const SAMPLES = 10

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What one pack's update would be, and why.
 * @returns {{ update: object|null, reasons: string[], tags: string[], tagKeys: string[] }}
 */
function plan (about = {}) {
  const before = Array.isArray(about.tags) ? about.tags : []
  const { tags, tagKeys } = normalizeTags(before)
  const tagsChange = !sameList(before, tags)
  if (!tagsChange && sameList(about.tagKeys, tagKeys)) return { update: null, reasons: [], tags, tagKeys }
  const reasons = []
  if (!tagsChange) reasons.push('tagKeys only')
  else {
    if (before.length > MAX_TAGS) reasons.push('capped')
    if (!sameList(before.slice(0, MAX_TAGS), tags)) reasons.push('cleaned or deduplicated')
  }
  return { update: { $set: { 'about.tags': tags, 'about.tagKeys': tagKeys } }, reasons, tags, tagKeys }
}

// Pages by _id alone: a tags filter on top made each page walk the _id index
// past every pack without tags (most of them) until 1000 matched, and the
// first page outlasted the socket timeout. A page of the _id index is always
// bounded; packs without tags are skipped here.
const PROJECTION = { name: 1, 'about.tags': 1, 'about.tagKeys': 1 }
const MAX_TIME_MS = 120000
const PROGRESS_EVERY = 50000

/**
 * @param {import('mongodb').Collection} collection
 * @param {{ apply?: boolean, batch?: number, pauseMs?: number, limit?: number, log?: Function }} [options]
 */
async function backfill (collection, { apply = false, batch: size = BATCH, pauseMs = PAUSE_MS, limit = LIMIT, log = console.log } = {}) {
  const stats = { scanned: 0, withTags: 0, update: 0, tagsChanged: 0, tagsBefore: 0, tagsAfter: 0, keys: 0, written: 0 }
  const reasons = {}
  const samples = []
  let last = null
  let nextProgress = PROGRESS_EVERY

  log(`${apply ? 'APPLY' : 'DRY RUN'}: pages of ${size}, pause ${pauseMs} ms`)

  while (stats.withTags < limit) {
    const page = await collection
      .find(last ? { _id: { $gt: last } } : {}, { projection: PROJECTION })
      .sort({ _id: 1 })
      .limit(size)
      .maxTimeMS(MAX_TIME_MS)
      .toArray()
    if (!page.length) break
    last = page[page.length - 1]._id
    stats.scanned += page.length

    const ops = []
    for (const pack of page) {
      const before = pack.about?.tags
      if (!Array.isArray(before) || !before.length) continue
      if (stats.withTags >= limit) break
      stats.withTags++
      const result = plan(pack.about)
      stats.tagsBefore += before.length
      stats.tagsAfter += result.tags.length
      stats.keys += result.tagKeys.length
      if (!result.update) continue
      stats.update++
      if (!sameList(before, result.tags)) stats.tagsChanged++
      for (const reason of result.reasons) reasons[reason] = (reasons[reason] || 0) + 1
      if (samples.length < SAMPLES && !result.reasons.includes('tagKeys only')) {
        samples.push({ name: pack.name, before: before.slice(0, 25), after: result.tags, tagKeys: result.tagKeys })
      }
      ops.push({ updateOne: { filter: { _id: pack._id }, update: result.update } })
    }

    if (apply && ops.length) {
      const res = await collection.bulkWrite(ops, { ordered: false })
      stats.written += res.modifiedCount
    }
    if (stats.scanned >= nextProgress) {
      nextProgress += PROGRESS_EVERY
      log(`  ${stats.scanned} scanned, ${stats.withTags} with tags, ${stats.update} to update${apply ? `, ${stats.written} written` : ''}`)
    }
    if (pauseMs) await sleep(pauseMs)
  }

  log(JSON.stringify({ apply, ...stats, reasons }, null, 2))
  for (const sample of samples) log(JSON.stringify(sample))
  return { stats, reasons, samples }
}

if (require.main === module) {
  // Its own connection, not database/connection.js: that one's 30 s socket
  // timeout and pool of 10-50 are for the bot's requests, not for a scan.
  const mongoose = require('mongoose')
  const schemas = require('../database/models')
  const uri = process.env.MONGODB_URI
  const connection = mongoose.createConnection(uri, {
    ...(uri && uri.startsWith('mongodb+srv://') ? {} : { directConnection: true }),
    autoIndex: false,
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: MAX_TIME_MS + 60000
  })
  const collection = connection.model('StickerSet', schemas.StickerSet).collection
  connection.asPromise()
    .then(() => backfill(collection, { apply }))
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(async () => {
      await connection.close().catch(() => {})
      process.exit()
    })
}

module.exports = { plan, backfill }
