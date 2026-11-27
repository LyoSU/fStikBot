// plan() of scripts/backfill-tag-keys.js: which packs it rewrites, and how.

const assert = require('assert')
const { plan } = require('./backfill-tag-keys')

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
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

console.log(`backfill-tag-keys: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
