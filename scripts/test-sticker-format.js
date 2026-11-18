// Unit tests for utils/sticker-format.js — which format a file becomes.

const assert = require('assert')
const { isVideoInput, isVideoNoteInput, initialFormat, urlPathname, formatFromPath, hasImageExtension } = require('../utils/sticker-format')

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

test('video from any of its signs', () => {
  assert.strictEqual(isVideoInput({ stickerType: 'video' }, {}), true)
  assert.strictEqual(isVideoInput({ stickerType: 'video_note' }, {}), true)
  assert.strictEqual(isVideoInput({ is_video: true }, {}), true)
  assert.strictEqual(isVideoInput({}, { mime_type: 'video/mp4' }), true)
  assert.strictEqual(isVideoInput({}, { mime_type: 'image/gif' }), true)
  assert.strictEqual(isVideoInput({}, { duration: 3 }), true)
  assert.strictEqual(isVideoInput({ stickerType: 'photo' }, { mime_type: 'image/jpeg' }), false)
})

test('round video', () => {
  assert.strictEqual(isVideoNoteInput({ stickerType: 'video_note' }, {}), true)
  assert.strictEqual(isVideoNoteInput({}, { video_note: true }), true)
  assert.strictEqual(isVideoNoteInput({ stickerType: 'video' }, {}), false)
})

test('initial format: animated beats video beats static', () => {
  assert.strictEqual(initialFormat({ isAnimated: true, isVideo: true }), 'animated')
  assert.strictEqual(initialFormat({ isVideoNote: true }), 'video')
  assert.strictEqual(initialFormat({}), 'static')
})

test('the extension corrects the format; no extension leaves it', () => {
  assert.strictEqual(formatFromPath('static', '/file/bot1/stickers/a.webm'), 'video')
  assert.strictEqual(formatFromPath('static', '/file/bot1/stickers/a.tgs'), 'animated')
  assert.strictEqual(formatFromPath('video', '/file/bot1/stickers/a.webp'), 'static')
  assert.strictEqual(formatFromPath('video', 'stickers/file_303092'), 'video')
})

test('pathname drops the query; non-URLs pass through', () => {
  assert.strictEqual(urlPathname(new URL('https://api.telegram.org/file/bot1/a.webm?x=1')), '/file/bot1/a.webm')
  assert.strictEqual(urlPathname('stickers/file_1'), 'stickers/file_1')
  assert.strictEqual(urlPathname(null), '')
})

test('image extensions', () => {
  assert.ok(hasImageExtension('/a.JPG'))
  assert.ok(hasImageExtension('/a.webp'))
  assert.ok(!hasImageExtension('/a.tgs'))
  assert.ok(!hasImageExtension('stickers/file_1'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('sticker-format test OK')
