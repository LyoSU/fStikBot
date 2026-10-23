// Unit tests for utils/tgs-static-fix.js — repairing a TGS Telegram refuses as
// static ("wrong file type"). The bot only calls it after such a refusal.

const assert = require('assert')
const zlib = require('zlib')
const { fixStaticTgs, hasSurvivingAnimation } = require('../utils/tgs-static-fix')

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

const ease = { i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] } }
const lottie = (rotation) => ({
  v: '5.5.2',
  fr: 60,
  ip: 0,
  op: 60,
  w: 512,
  h: 512,
  assets: [],
  layers: [{
    ty: 4,
    ind: 1,
    ip: 0,
    op: 60,
    st: 0,
    ks: { o: { a: 0, k: 100 }, s: { a: 0, k: [100, 100, 100] }, p: { a: 0, k: [256, 256, 0] }, r: rotation },
    shapes: []
  }]
})
const gz = (doc) => zlib.gzipSync(Buffer.from(JSON.stringify(doc)))
const parse = (buffer) => JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))

test('a real animation is left untouched', () => {
  const input = gz(lottie({ a: 1, k: [{ t: 0, s: [0], ...ease }, { t: 60, s: [90] }] }))
  const out = fixStaticTgs(input)
  assert.strictEqual(out.changed, false)
  assert.strictEqual(out.buffer, input)
})

test('keyframes without interpolators get them back, and the file animates', () => {
  const out = fixStaticTgs(gz(lottie({ a: 1, k: [{ t: 0, s: [0] }, { t: 60, s: [90] }] })))
  assert.strictEqual(out.changed, true)
  assert.strictEqual(out.revived, 1)
  assert.ok(hasSurvivingAnimation(parse(out.buffer)))
})

test('a fully static file gets a micro-animation on its layers', () => {
  const out = fixStaticTgs(gz(lottie({ a: 0, k: 0 })))
  assert.strictEqual(out.changed, true)
  assert.strictEqual(out.micro, true)
  const layer = parse(out.buffer).layers[0]
  assert.strictEqual(layer.ks.o.a, 1, 'opacity is animated')
  assert.ok(hasSurvivingAnimation(parse(out.buffer)))
})

test('a constant "animated" track does not count as animation', () => {
  const doc = lottie({ a: 1, k: [{ t: 0, s: [45], ...ease }, { t: 60, s: [45] }] })
  assert.strictEqual(hasSurvivingAnimation(doc), false)
})

test('not a gzipped Lottie → error, never throws', () => {
  assert.ok(fixStaticTgs(Buffer.from('nope')).error)
  assert.ok(fixStaticTgs(gz({ v: '5.5.2' })).error)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log('tgs static fix test OK')
