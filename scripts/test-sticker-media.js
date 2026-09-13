// Caption flags and media extraction for the sticker pipeline (utils/sticker-media.js).
const assert = require('assert')
const { parseCaption, extractMedia, isTenorMediaUrl } = require('../utils/sticker-media')

let failed = 0
const test = (name, fn) => {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}

test('"!" alone removes the background and is dropped from the emoji text', () => {
  assert.deepStrictEqual(parseCaption('! 😺'), { flags: { removeBg: true }, text: '😺' })
})

test('"Wow! 😂" is not the background flag', () => {
  assert.deepStrictEqual(parseCaption('Wow! 😂'), { flags: {}, text: 'Wow! 😂' })
})

test('roundit / cropit are whole words, any case', () => {
  assert.deepStrictEqual(parseCaption('ROUNDIT cropit 🔥').flags, { video_note: true, forceCrop: true })
  assert.deepStrictEqual(parseCaption('grounditself cropitty').flags, {})
})

test('empty caption', () => {
  assert.deepStrictEqual(parseCaption(undefined), { flags: {}, text: '' })
})

test('photo → largest size, copied', () => {
  const message = { photo: [{ file_id: 's' }, { file_id: 'l' }] }
  const file = extractMedia(message)
  assert.strictEqual(file.file_id, 'l')
  assert.strictEqual(file.stickerType, 'photo')
  file.emoji = 'x'
  assert.strictEqual(message.photo[1].emoji, undefined)
})

test('animation wins over its document twin, and takes a Tenor URL', () => {
  const file = extractMedia({
    animation: { file_id: 'a' },
    document: { file_id: 'a', mime_type: 'video/mp4' },
    caption: 'https://media.tenor.com/x.mp4'
  })
  assert.strictEqual(file.stickerType, 'animation')
  assert.strictEqual(file.fileUrl, 'https://media.tenor.com/x.mp4')
})

test('only real https Tenor hosts count', () => {
  assert.strictEqual(isTenorMediaUrl('https://tenor.com.evil.io/x'), false)
  assert.strictEqual(isTenorMediaUrl('http://media.tenor.com/x'), false)
  assert.strictEqual(isTenorMediaUrl('https://c.tenor.com/x'), true)
})

test('documents: images and videos yes, HEIC and others no', () => {
  assert.strictEqual(extractMedia({ document: { mime_type: 'image/png' } }).stickerType, 'document')
  assert.strictEqual(extractMedia({ document: { mime_type: 'image/heic' } }), null)
  assert.strictEqual(extractMedia({ document: { mime_type: 'application/zip' } }), null)
})

test('video note is flagged round', () => {
  assert.strictEqual(extractMedia({ video_note: { file_id: 'v' } }).video_note, true)
})

test('text message has no media', () => {
  assert.strictEqual(extractMedia({ text: 'hi' }), null)
})

if (failed) process.exit(1)
console.log('sticker-media test OK')
