// Unit tests for utils/lottie-rescale.js — retargeting a TGS (gzipped Lottie)
// between the 512×512 sticker canvas and the 100×100 custom-emoji canvas.
// Pure: no network, no DB. Fixtures are built in-memory.

const assert = require('assert')
const zlib = require('zlib')
const { rescaleTgs, readTgsSize, MAX_TGS_BYTES } = require('../utils/lottie-rescale')

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

// Minimal valid Lottie: one shape layer with a red 200×200 rectangle.
function makeLottie (size, extra = {}) {
  return {
    v: '5.5.2',
    fr: 60,
    ip: 0,
    op: 60,
    w: size,
    h: size,
    nm: 'fixture',
    ddd: 0,
    assets: [],
    layers: [{
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'rect',
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [size / 2, size / 2, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] }
      },
      ao: 0,
      shapes: [
        { ty: 'rc', d: 1, s: { a: 0, k: [200, 200] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
        { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0
    }],
    ...extra
  }
}

const pack = (json) => zlib.gzipSync(Buffer.from(JSON.stringify(json)))
const unpack = (buf) => JSON.parse(zlib.gunzipSync(buf).toString())

;(async () => {
  await test('readTgsSize reports the canvas of a gzipped Lottie', () => {
    assert.deepStrictEqual(readTgsSize(pack(makeLottie(512))), { w: 512, h: 512 })
    assert.deepStrictEqual(readTgsSize(pack(makeLottie(100))), { w: 100, h: 100 })
  })

  await test('512 → 100: canvas becomes 100×100 and the original layers are wrapped in one scaled precomp', () => {
    const result = rescaleTgs(pack(makeLottie(512)), 100)
    assert.ok(result.buffer, `expected buffer, got ${JSON.stringify(result)}`)
    const out = unpack(result.buffer)

    assert.strictEqual(out.w, 100)
    assert.strictEqual(out.h, 100)
    assert.strictEqual(out.layers.length, 1, 'exactly one root layer')

    const wrapper = out.layers[0]
    assert.strictEqual(wrapper.ty, 0, 'root layer is a precomp')
    assert.strictEqual(wrapper.w, 512, 'precomp keeps the source width')
    assert.strictEqual(wrapper.h, 512, 'precomp keeps the source height')
    const scale = wrapper.ks.s.k
    assert.ok(Math.abs(scale[0] - 100 / 512 * 100) < 1e-9, `scale x = ${scale[0]}`)
    assert.ok(Math.abs(scale[1] - 100 / 512 * 100) < 1e-9, `scale y = ${scale[1]}`)
    assert.strictEqual(wrapper.ip, 0)
    assert.strictEqual(wrapper.op, 60)

    const asset = out.assets.find((a) => a.id === wrapper.refId)
    assert.ok(asset, 'wrapper refId points at an asset')
    assert.strictEqual(asset.layers.length, 1)
    assert.strictEqual(asset.layers[0].nm, 'rect', 'original layer lives inside the precomp')
  })

  await test('100 → 512: scales up by 512/100 and keeps fr/ip/op', () => {
    const result = rescaleTgs(pack(makeLottie(100)), 512)
    const out = unpack(result.buffer)
    assert.strictEqual(out.w, 512)
    assert.strictEqual(out.h, 512)
    assert.strictEqual(out.fr, 60)
    assert.strictEqual(out.ip, 0)
    assert.strictEqual(out.op, 60)
    const scale = out.layers[0].ks.s.k
    assert.ok(Math.abs(scale[0] - 512) < 1e-9, `scale x = ${scale[0]}`)
  })

  await test('same canvas: returns the input buffer untouched', () => {
    const input = pack(makeLottie(512))
    const result = rescaleTgs(input, 512)
    assert.strictEqual(result.buffer, input, 'same Buffer instance, no re-encode')
  })

  await test('existing assets are preserved and the wrapper asset id does not collide', () => {
    const src = makeLottie(512, { assets: [{ id: 'comp_0', layers: [] }] })
    const out = unpack(rescaleTgs(pack(src), 100).buffer)
    assert.ok(out.assets.some((a) => a.id === 'comp_0'), 'original asset kept')
    const ids = out.assets.map((a) => a.id)
    assert.strictEqual(new Set(ids).size, ids.length, 'asset ids unique')
  })

  await test('rescaling twice is idempotent in geometry (100 → 512 → 100 renders at 100)', () => {
    const once = rescaleTgs(pack(makeLottie(100)), 512).buffer
    const twice = rescaleTgs(once, 100).buffer
    const out = unpack(twice)
    assert.strictEqual(out.w, 100)
    assert.strictEqual(out.h, 100)
  })

  await test('not a gzip / not a Lottie → invalid_animated error, never throws', () => {
    assert.deepStrictEqual(rescaleTgs(Buffer.from('nope'), 100), { error: { i18nKey: 'sticker.add.error.invalid_animated' } })
    assert.deepStrictEqual(rescaleTgs(zlib.gzipSync(Buffer.from('[1,2,3]')), 100), { error: { i18nKey: 'sticker.add.error.invalid_animated' } })
    assert.deepStrictEqual(rescaleTgs(zlib.gzipSync(Buffer.from('{"w":512}')), 100), { error: { i18nKey: 'sticker.add.error.invalid_animated' } })
  })

  await test('result over the Telegram 64 KB limit → animated_too_big error', () => {
    // Incompressible payload so the gzipped result stays well over the cap.
    const noise = require('crypto').randomBytes(90 * 1024).toString('hex')
    const result = rescaleTgs(pack(makeLottie(512, { nm: noise })), 100)
    assert.deepStrictEqual(result, { error: { i18nKey: 'sticker.add.error.animated_too_big' } })
    assert.strictEqual(MAX_TGS_BYTES, 64 * 1024)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('lottie rescale test OK')
})()
