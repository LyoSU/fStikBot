// Tag normalization (utils/tag-normalize.js) against the shared test vectors.
// The same fixtures file is copied into fstikbot-api: both must pass it.

const assert = require('assert')
const fixtures = require('../utils/tag-normalize.fixtures.json')
const shortKeys = require('../utils/tag-short-keys.json')
const { SPEC_VERSION, normalizeTag, tagKey, normalizeTags } = require('../utils/tag-normalize')

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

test('fixtures and dictionary are of this spec', () => {
  assert.strictEqual(fixtures.version, SPEC_VERSION)
  assert.strictEqual(shortKeys.version, SPEC_VERSION)
})

for (const [input, expected] of fixtures.normalizeTag) {
  test(`normalizeTag(${JSON.stringify(input)})`, () => assert.strictEqual(normalizeTag(input), expected))
}
for (const [input, expected] of fixtures.tagKey) {
  test(`tagKey(${JSON.stringify(input)})`, () => assert.strictEqual(tagKey(input), expected))
}
for (const { in: input, max, out } of fixtures.normalizeTags) {
  test(`normalizeTags(${JSON.stringify(input).slice(0, 60)})`, () => {
    assert.deepStrictEqual(normalizeTags(input, max ? { max } : undefined), out)
  })
}

test('every dictionary form is a normalized short tag and maps to one key', () => {
  const seen = new Map()
  for (const [key, forms] of Object.entries(shortKeys.keys)) {
    for (const form of forms) {
      assert.strictEqual(normalizeTag(form), form, `${form} is not normalized`)
      assert.ok([...form.replace(/ /g, '')].length < 5, `${form} is not short`)
      assert.ok(!seen.has(form), `${form} is under ${seen.get(form)} and ${key}`)
      seen.set(form, key)
      assert.strictEqual(tagKey(form), key)
    }
  }
})

console.log(`tag-normalize: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
