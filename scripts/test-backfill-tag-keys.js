// plan() of scripts/backfill-tag-keys.js: which packs it rewrites, and how.

const assert = require('assert')
const { plan, backfill } = require('./backfill-tag-keys')

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

test('a pack already normalized is left alone', () => {
  assert.strictEqual(plan({ tags: ['Anime', 'cat'], tagKeys: ['anime', 'cat'] }).update, null)
})

test('a pack with clean tags and no keys gets its keys only', () => {
  const result = plan({ tags: ['Anime', 'котики'] })
  assert.deepStrictEqual(result.update, { $set: { 'about.tags': ['Anime', 'котики'], 'about.tagKeys': ['anime', 'kotiki'] } })
  assert.deepStrictEqual(result.reasons, ['tagKeys only'])
})

test('duplicates and edges are cleaned in the author spelling', () => {
  const result = plan({ tags: ['#Anime', 'anime', 'CAT!', 'Аниме'] })
  assert.deepStrictEqual(result.tags, ['Anime', 'CAT', 'Аниме'])
  assert.deepStrictEqual(result.tagKeys, ['anime', 'cat'])
  assert.deepStrictEqual(result.reasons, ['cleaned or deduplicated'])
})

test('a stuffed pack keeps its first 20', () => {
  const tags = Array.from({ length: 449 }, (_, i) => `tag${i}`)
  const result = plan({ tags })
  assert.deepStrictEqual(result.tags, tags.slice(0, 20))
  assert.deepStrictEqual(result.reasons, ['capped'])
})

test('keys computed by an older spec are replaced', () => {
  const result = plan({ tags: ['Anime'], tagKeys: ['old'] })
  assert.deepStrictEqual(result.update.$set['about.tagKeys'], ['anime'])
})

// A collection of packs mostly without tags, recording every query.
function fakeCollection (packs) {
  const queries = []
  const writes = []
  return {
    queries,
    writes,
    find (filter, options) {
      const query = { filter, options }
      queries.push(query)
      const cursor = {
        sort (sort) { query.sort = sort; return cursor },
        limit (n) { query.limit = n; return cursor },
        maxTimeMS (ms) { query.maxTimeMS = ms; return cursor },
        async toArray () {
          const after = filter._id?.$gt
          return packs.filter((pack) => after === undefined || pack._id > after).slice(0, query.limit)
        }
      }
      return cursor
    },
    async bulkWrite (ops) {
      writes.push(...ops)
      return { modifiedCount: ops.length }
    }
  }
}

const packs = Array.from({ length: 2500 }, (_, i) => ({
  _id: i + 1,
  name: `p${i + 1}`,
  about: i % 100 === 0 ? { tags: ['#Cat', 'cat', 'Котики'] } : (i % 7 === 0 ? { description: 'x' } : undefined)
}))

;(async () => {
  await test('pages are bounded by _id alone, with a time limit and a tight projection', async () => {
    const collection = fakeCollection(packs)
    const { stats } = await backfill(collection, { batch: 1000, pauseMs: 0, log: () => {} })
    assert.strictEqual(collection.queries.length, 4) // 1000 + 1000 + 500 + the empty page
    for (const { filter, options, sort, limit, maxTimeMS } of collection.queries) {
      assert.deepStrictEqual(Object.keys(filter).filter((key) => key !== '_id'), [])
      assert.deepStrictEqual(sort, { _id: 1 })
      assert.strictEqual(limit, 1000)
      assert.ok(maxTimeMS > 0)
      assert.deepStrictEqual(options.projection, { name: 1, 'about.tags': 1, 'about.tagKeys': 1 })
    }
    assert.deepStrictEqual(collection.queries[1].filter, { _id: { $gt: 1000 } })
    assert.strictEqual(stats.scanned, 2500)
    assert.strictEqual(stats.withTags, 25)
    assert.strictEqual(stats.update, 25)
  })

  await test('a dry run writes nothing, an applied run writes the plan', async () => {
    const dry = fakeCollection(packs)
    await backfill(dry, { pauseMs: 0, log: () => {} })
    assert.strictEqual(dry.writes.length, 0)

    const wet = fakeCollection(packs)
    const { stats } = await backfill(wet, { apply: true, pauseMs: 0, log: () => {} })
    assert.strictEqual(wet.writes.length, 25)
    assert.strictEqual(stats.written, 25)
    assert.deepStrictEqual(wet.writes[0].updateOne, {
      filter: { _id: 1 },
      update: { $set: { 'about.tags': ['Cat', 'Котики'], 'about.tagKeys': ['cat', 'kotiki'] } }
    })
  })

  await test('--limit counts packs with tags', async () => {
    const collection = fakeCollection(packs)
    const { stats } = await backfill(collection, { limit: 3, pauseMs: 0, log: () => {} })
    assert.strictEqual(stats.withTags, 3)
  })

  await test('progress is logged every 50k scanned', async () => {
    const many = Array.from({ length: 120000 }, (_, i) => ({ _id: i + 1 }))
    const lines = []
    await backfill(fakeCollection(many), { pauseMs: 0, log: (line) => lines.push(line) })
    assert.strictEqual(lines.filter((line) => / scanned, /.test(line)).length, 2)
  })

  console.log(`backfill-tag-keys: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
})()
