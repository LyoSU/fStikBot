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

async function run (db) {
  await db.connection.asPromise()
  const collection = db.StickerSet.collection
  const stats = { withTags: 0, update: 0, tagsChanged: 0, tagsBefore: 0, tagsAfter: 0, keys: 0, written: 0 }
  const reasons = {}
  const samples = []
  let last = null

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: batches of ${BATCH}, pause ${PAUSE_MS} ms`)

  while (stats.withTags < LIMIT) {
    const filter = { 'about.tags.0': { $exists: true } }
    if (last) filter._id = { $gt: last }
    const batch = await collection
      .find(filter, { projection: { name: 1, 'about.tags': 1, 'about.tagKeys': 1 } })
      .sort({ _id: 1 })
      .limit(BATCH)
      .toArray()
    if (!batch.length) break
    last = batch[batch.length - 1]._id

    const ops = []
    for (const pack of batch) {
      stats.withTags++
      const before = pack.about.tags
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
    console.log(`  ${stats.withTags} packs with tags read, ${stats.update} to update${apply ? `, ${stats.written} written` : ''}`)
    if (PAUSE_MS) await sleep(PAUSE_MS)
  }

  console.log(JSON.stringify({ apply, ...stats, reasons }, null, 2))
  for (const sample of samples) console.log(JSON.stringify(sample))
}

if (require.main === module) {
  // Required only here: the test loads plan() without a database.
  const { db } = require('../database')
  run(db)
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(async () => {
      await db.connection.close().catch(() => {})
      process.exit()
    })
}

module.exports = { plan }
