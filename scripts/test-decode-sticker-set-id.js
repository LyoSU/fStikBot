// Unit tests for utils/decode-sticker-set-id.js. gram.js hands over the set
// id as a *signed* int64 BigInt; ids are built here the same way.

const assert = require('assert')
const decodeStickerSetId = require('../utils/decode-sticker-set-id')

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const signed = (u64) => BigInt.asIntN(64, u64)

// Standard format: owner in the upper 32 bits, set number in the lower.
const standardId = (owner, set) => signed((BigInt(owner) << 32n) | BigInt(set))

// Extended format (owners past 32 bits): byte 24-31 is 0xff, the upper half
// holds owner - 0x180000000 as a signed 32-bit value.
const extendedId = (owner, set, dc) => signed(
  (BigInt.asUintN(32, BigInt(owner) - 0x180000000n) << 32n) | (0xffn << 24n) | (BigInt(dc) << 20n) | BigInt(set)
)

test('standard format, small owner id', () => {
  const decoded = decodeStickerSetId(standardId(123456789, 7))
  assert.strictEqual(decoded.ownerId, 123456789)
  assert.strictEqual(decoded.setId, 7)
  assert.strictEqual(decoded.isExtended, false)
})

test('standard format, owner id past 2^31 (negative signed set id)', () => {
  const owner = 3000000000
  const id = standardId(owner, 1)
  assert.ok(id < 0n, 'fixture must be a negative signed id')
  assert.strictEqual(decodeStickerSetId(id).ownerId, owner)
})

test('standard format, highest 32-bit owner id', () => {
  assert.strictEqual(decodeStickerSetId(standardId(2 ** 32 - 1, 1)).ownerId, 2 ** 32 - 1)
})

for (const owner of [2 ** 32, 5000000000, 6442450943, 6442450944, 8000000000, 2 ** 33 - 1]) {
  test(`extended format, owner ${owner}`, () => {
    const decoded = decodeStickerSetId(extendedId(owner, 3, 2))
    assert.strictEqual(decoded.ownerId, owner)
    assert.strictEqual(decoded.setId, 3)
    assert.strictEqual(decoded.dcId, 2)
    assert.strictEqual(decoded.isExtended, true)
  })
}

test('an unsigned id decodes the same as its signed form', () => {
  const id = extendedId(5000000000, 1, 4)
  assert.deepStrictEqual(decodeStickerSetId(BigInt.asUintN(64, id)), decodeStickerSetId(id))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
