// Read-only investigation of the Sticker + StickerSet collections.
// Produces schema stats for migration planning without touching any docs.
//
// Usage: node scripts/inspect-db.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { db } = require('../database')

function pct (a, b) {
  if (!b) return '0%'
  return ((a / b) * 100).toFixed(1) + '%'
}

async function run () {
  console.log('=== DB inspection ===')
  console.log('DB host:', db.connection.host || '?')
  console.log('DB name:', db.connection.name || '?')

  // Fast metadata counts (not an aggregation)
  const stickerCount = await db.Sticker.estimatedDocumentCount()
  const packCount = await db.StickerSet.estimatedDocumentCount()
  console.log(`\nestimatedDocumentCount:\n  stickers  = ${stickerCount.toLocaleString()}\n  packs     = ${packCount.toLocaleString()}`)

  // Indexes
  const stickerIndexes = await db.Sticker.collection.indexInformation({ full: true })
  const packIndexes = await db.StickerSet.collection.indexInformation({ full: true })
  console.log('\nSticker indexes:')
  stickerIndexes.forEach((i) => console.log(` - ${i.name}  keys=${JSON.stringify(i.key)}${i.sparse ? ' sparse' : ''}${i.unique ? ' unique' : ''}`))
  console.log('\nStickerSet indexes:')
  packIndexes.forEach((i) => console.log(` - ${i.name}  keys=${JSON.stringify(i.key)}${i.sparse ? ' sparse' : ''}${i.unique ? ' unique' : ''}`))

  // Scan a sample of Sticker docs for schema shape.
  // For small DBs we just walk all of them; for large we sample.
  const sampleSize = Math.min(stickerCount, 1000)
  console.log(`\nSampling ${sampleSize} Sticker docs for schema shape …`)
  const t0 = Date.now()
  let sample
  if (stickerCount <= 2000) {
    sample = await db.Sticker.find({}).limit(sampleSize).lean()
  } else {
    sample = await db.Sticker.aggregate([{ $sample: { size: sampleSize } }]).allowDiskUse(true).option({ maxTimeMS: 60000 })
  }
  console.log(`  sample fetched in ${Date.now() - t0}ms (size=${sample.length})`)

  const stats = {
    withInfoFileId: 0,
    withFileFileId: 0,
    withFlatFileId: 0,
    withOriginal: 0,
    missingStickerType: 0,
    missingFileUniqueId: 0,
    deleted: 0,
    legacyOnly: 0,
    newOnly: 0,
    both: 0
  }

  for (const doc of sample) {
    const hasInfo = !!(doc.info && doc.info.file_id)
    const hasFile = !!(doc.file && doc.file.file_id)
    const hasFlat = !!doc.fileId
    const hasOriginal = !!(doc.original && doc.original.fileId)

    if (hasInfo) stats.withInfoFileId++
    if (hasFile) stats.withFileFileId++
    if (hasFlat) stats.withFlatFileId++
    if (hasOriginal) stats.withOriginal++
    if (!doc.stickerType) stats.missingStickerType++
    if (!doc.fileUniqueId) stats.missingFileUniqueId++
    if (doc.deleted) stats.deleted++

    if (hasInfo && !hasFlat) stats.legacyOnly++
    else if (hasFlat && !hasInfo) stats.newOnly++
    else if (hasInfo && hasFlat) stats.both++
  }

  console.log(`\nShape distribution (out of ${sample.length} sampled):`)
  console.log(`  with info.file_id        = ${stats.withInfoFileId}  (${pct(stats.withInfoFileId, sample.length)})`)
  console.log(`  with file.file_id        = ${stats.withFileFileId}  (${pct(stats.withFileFileId, sample.length)})`)
  console.log(`  with flat fileId         = ${stats.withFlatFileId}  (${pct(stats.withFlatFileId, sample.length)})`)
  console.log(`  with original.fileId     = ${stats.withOriginal}  (${pct(stats.withOriginal, sample.length)})`)
  console.log(`  missing stickerType      = ${stats.missingStickerType}  (${pct(stats.missingStickerType, sample.length)})`)
  console.log(`  missing fileUniqueId     = ${stats.missingFileUniqueId}  (${pct(stats.missingFileUniqueId, sample.length)})`)
  console.log(`  deleted flag set         = ${stats.deleted}  (${pct(stats.deleted, sample.length)})`)
  console.log(`  LEGACY ONLY (info only)  = ${stats.legacyOnly}  (${pct(stats.legacyOnly, sample.length)})`)
  console.log(`  NEW ONLY (fileId only)   = ${stats.newOnly}  (${pct(stats.newOnly, sample.length)})`)
  console.log(`  BOTH fields present      = ${stats.both}  (${pct(stats.both, sample.length)})`)

  const legacyEstimate = Math.round(stickerCount * (stats.legacyOnly / sample.length))
  const missingTypeEstimate = Math.round(stickerCount * (stats.missingStickerType / sample.length))
  console.log('\nExtrapolated to full collection:')
  console.log(`  legacy-only stickers     ≈ ${legacyEstimate.toLocaleString()}`)
  console.log(`  stickers missing type    ≈ ${missingTypeEstimate.toLocaleString()}`)

  const oldest = await db.Sticker.findOne({}).sort({ _id: 1 }).select('_id').lean()
  const newest = await db.Sticker.findOne({}).sort({ _id: -1 }).select('_id').lean()
  if (oldest && newest) {
    console.log('\nSticker _id range:')
    console.log(`  oldest: ${oldest._id} (${oldest._id.getTimestamp().toISOString()})`)
    console.log(`  newest: ${newest._id} (${newest._id.getTimestamp().toISOString()})`)
  }

  const packSampleSize = Math.min(packCount, 200)
  const packSample = packCount <= 500
    ? await db.StickerSet.find({}).limit(packSampleSize).lean()
    : await db.StickerSet.aggregate([{ $sample: { size: packSampleSize } }]).allowDiskUse(true).option({ maxTimeMS: 30000 })
  const packStats = { hide: 0, deleted: 0, create: 0, inline: 0, thirdParty: 0, public: 0 }
  for (const p of packSample) {
    if (p.hide) packStats.hide++
    if (p.deleted) packStats.deleted++
    if (p.create) packStats.create++
    if (p.inline) packStats.inline++
    if (p.thirdParty) packStats.thirdParty++
    if (p.public) packStats.public++
  }
  console.log(`\nStickerSet flag distribution (of ${packSample.length} sampled):`)
  Object.entries(packStats).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} = ${v} (${pct(v, packSample.length)})`))

  try {
    const collStats = await db.Sticker.collection.stats()
    console.log('\nSticker collection stats:')
    console.log(`  storageSize  = ${(collStats.storageSize / 1e9).toFixed(2)} GB`)
    console.log(`  totalSize    = ${(collStats.totalSize / 1e9).toFixed(2)} GB`)
    console.log(`  avgObjSize   = ${collStats.avgObjSize} bytes`)
    console.log(`  indexSize    = ${(collStats.totalIndexSize / 1e9).toFixed(2)} GB`)
  } catch (err) {
    console.log('\n(collection stats unavailable:', err.message, ')')
  }

  console.log('\n=== done ===')
  process.exit(0)
}

run().catch((err) => {
  console.error('inspect failed:', err)
  process.exit(1)
})
