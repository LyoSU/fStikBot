// Unit tests for utils/sticker-geometry.js — the output size of a static
// sticker: longer side exactly 512, the other proportional, never padded.

const assert = require('assert')
const { fitStickerSize, STICKER_SIDE } = require('../utils/sticker-geometry')

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

test('STICKER_SIDE is Telegram\'s 512', () => {
  assert.strictEqual(STICKER_SIDE, 512)
})

test('small square (custom emoji 100×100) is scaled UP to 512×512, not padded', () => {
  assert.deepStrictEqual(fitStickerSize(100, 100), { width: 512, height: 512 })
})

test('small landscape 300×200 → 512 wide, height proportional', () => {
  assert.deepStrictEqual(fitStickerSize(300, 200), { width: 512, height: 341 })
})

test('large landscape 1000×400 → 512×205', () => {
  assert.deepStrictEqual(fitStickerSize(1000, 400), { width: 512, height: 205 })
})

test('large portrait 400×1000 → 205×512', () => {
  assert.deepStrictEqual(fitStickerSize(400, 1000), { width: 205, height: 512 })
})

test('already 512×512 stays 512×512', () => {
  assert.deepStrictEqual(fitStickerSize(512, 512), { width: 512, height: 512 })
})

test('one side already 512 (512×300) is left alone', () => {
  assert.deepStrictEqual(fitStickerSize(512, 300), { width: 512, height: 300 })
})

test('extreme aspect never rounds the short side to 0', () => {
  assert.deepStrictEqual(fitStickerSize(5000, 1), { width: 512, height: 1 })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('sticker geometry test OK')
