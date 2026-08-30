// Unit tests for utils/sniff-media.js — container detection from magic bytes.
// Used to catch mp4/webm/gif originals that reach the static pipeline with no
// mime_type, duration or file extension to tell them apart from an image.

const assert = require('assert')
const { sniffMedia, isVideoContainer } = require('../utils/sniff-media')

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

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex')

test('mp4 (ftypmp42) from the prod log is video', () => {
  const buf = hex('0000001c667479706d7034320000000169736f6d')
  assert.strictEqual(sniffMedia(buf), 'mp4')
  assert.strictEqual(isVideoContainer(buf), true)
})

test('mp4 (ftypisom) from the prod log is video', () => {
  const buf = hex('000000206674797069736f6d0000020069736f6d')
  assert.strictEqual(sniffMedia(buf), 'mp4')
  assert.strictEqual(isVideoContainer(buf), true)
})

test('webm/matroska EBML header is video', () => {
  const buf = hex('1a45dfa3 9f4286 81 01 42f7 81 01')
  assert.strictEqual(sniffMedia(buf), 'webm')
  assert.strictEqual(isVideoContainer(buf), true)
})

test('GIF89a counts as video (Telegram turns it into mp4 anyway)', () => {
  const buf = Buffer.from('GIF89a\x00\x01\x00\x01', 'binary')
  assert.strictEqual(sniffMedia(buf), 'gif')
  assert.strictEqual(isVideoContainer(buf), true)
})

test('png is an image, not video', () => {
  const buf = hex('89504e470d0a1a0a 0000000d49484452')
  assert.strictEqual(sniffMedia(buf), 'png')
  assert.strictEqual(isVideoContainer(buf), false)
})

test('webp (RIFF....WEBP) is an image', () => {
  const buf = Buffer.concat([Buffer.from('RIFF'), hex('00000000'), Buffer.from('WEBPVP8 ')])
  assert.strictEqual(sniffMedia(buf), 'webp')
  assert.strictEqual(isVideoContainer(buf), false)
})

test('jpeg is an image', () => {
  assert.strictEqual(sniffMedia(hex('ffd8ffe000104a464946')), 'jpeg')
})

test('gzip (a .tgs) is neither image nor video', () => {
  const buf = hex('1f8b0800000000000003')
  assert.strictEqual(sniffMedia(buf), 'tgs')
  assert.strictEqual(isVideoContainer(buf), false)
})

test('unknown / short / empty input is null and not video', () => {
  assert.strictEqual(sniffMedia(Buffer.alloc(0)), null)
  assert.strictEqual(sniffMedia(Buffer.from('ab')), null)
  assert.strictEqual(sniffMedia(null), null)
  assert.strictEqual(isVideoContainer(null), false)
  assert.strictEqual(isVideoContainer(Buffer.from('hello world!')), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('sniff-media test OK')
