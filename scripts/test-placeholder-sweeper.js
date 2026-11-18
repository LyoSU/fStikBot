// Unit tests for utils/placeholder-sweeper.js and utils/placeholder-schedule.js.
// No DB, no network: the repo and telegram are fakes.

const assert = require('assert')
const { createPlaceholderSweeper } = require('../utils/placeholder-sweeper')
const { CHECK_DELAYS_MS, RETRY_AFTER_ERROR_MS, nextPlaceholderCheck, firstPlaceholderCheck } = require('../utils/placeholder-schedule')

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
    console.log(`        ${error.stack}`)
  }
}

const NOW = Date.UTC(2026, 10, 18, 12)
const PH = 'ph-uid'
const ph = { file_unique_id: PH, file_id: 'ph-file' }
const real = (n) => ({ file_unique_id: `real-${n}`, file_id: `real-file-${n}` })

function makePack (extra = {}) {
  const pack = {
    _id: 'p1',
    name: 'pack_by_bot',
    placeholderFileUniqueId: PH,
    placeholderCheckAt: new Date(NOW - 1000),
    placeholderChecks: 0,
    saved: 0,
    ...extra
  }
  pack.save = async () => { pack.saved++ }
  return pack
}

function makeRepo (packs) {
  const repo = {
    packs,
    rescheduled: [],
    cleared: [],
    due: async (at, limit) => packs.filter((p) => p.placeholderCheckAt && p.placeholderCheckAt <= at).slice(0, limit),
    reschedule: async (pack, at, checks) => { repo.rescheduled.push({ name: pack.name, at, checks }) },
    clear: async (pack) => { repo.cleared.push(pack.name) }
  }
  return repo
}

function makeTelegram ({ set, getError, deleteError } = {}) {
  const calls = []
  return {
    calls,
    getStickerSet: async (name) => {
      calls.push(['getStickerSet', name])
      if (getError) throw getError
      return set
    },
    callApi: async (method, payload) => {
      calls.push([method, payload])
      if (deleteError) throw deleteError
      return true
    }
  }
}

const sweeper = (repo, telegram) => createPlaceholderSweeper({
  repo, telegram, now: () => NOW, gapMs: 0, log: { info () {}, warn () {} }
})

const main = async () => {
  await test('schedule: first look 15 min after creation, then spaced out, then none', () => {
    assert.strictEqual(firstPlaceholderCheck(NOW).getTime(), NOW + CHECK_DELAYS_MS[0])
    assert.strictEqual(nextPlaceholderCheck(1, NOW).getTime(), NOW + CHECK_DELAYS_MS[1])
    assert.strictEqual(nextPlaceholderCheck(CHECK_DELAYS_MS.length, NOW), null)
  })

  await test('placeholder next to stickers added outside the bot is deleted and the marker cleared', async () => {
    const pack = makePack()
    const repo = makeRepo([pack])
    const telegram = makeTelegram({ set: { stickers: [ph, real(1), real(2)] } })
    const outcome = await sweeper(repo, telegram).tick()
    assert.deepStrictEqual(outcome, { resolved: 1 })
    assert.deepStrictEqual(telegram.calls[1], ['deleteStickerFromSet', { sticker: 'ph-file' }])
    assert.strictEqual(pack.placeholderFileUniqueId, undefined)
    assert.strictEqual(pack.placeholderCheckAt, undefined)
    assert.strictEqual(pack.saved, 1)
  })

  await test('a set holding only the placeholder is left alone and looked at again later', async () => {
    const pack = makePack({ placeholderChecks: 1 })
    const repo = makeRepo([pack])
    const telegram = makeTelegram({ set: { stickers: [ph] } })
    const outcome = await sweeper(repo, telegram).tick()
    assert.deepStrictEqual(outcome, { waiting: 1 })
    assert.ok(!telegram.calls.some(([m]) => m === 'deleteStickerFromSet'), 'must never delete the last sticker')
    assert.deepStrictEqual(repo.rescheduled, [{ name: 'pack_by_bot', at: new Date(NOW + CHECK_DELAYS_MS[2]), checks: 2 }])
  })

  await test('after the last look the pack leaves the sweep, marker kept for the add path', async () => {
    const pack = makePack({ placeholderChecks: CHECK_DELAYS_MS.length - 1 })
    const repo = makeRepo([pack])
    await sweeper(repo, makeTelegram({ set: { stickers: [ph] } })).tick()
    assert.deepStrictEqual(repo.rescheduled, [{ name: 'pack_by_bot', at: null, checks: CHECK_DELAYS_MS.length }])
    assert.strictEqual(pack.placeholderFileUniqueId, PH)
  })

  await test('a placeholder the user already removed: marker cleared, nothing deleted', async () => {
    const pack = makePack()
    const telegram = makeTelegram({ set: { stickers: [real(1)] } })
    const outcome = await sweeper(makeRepo([pack]), telegram).tick()
    assert.deepStrictEqual(outcome, { resolved: 1 })
    assert.strictEqual(pack.placeholderFileUniqueId, undefined)
    assert.ok(!telegram.calls.some(([m]) => m === 'deleteStickerFromSet'))
  })

  await test('a pack Telegram no longer has is dropped from the sweep', async () => {
    const repo = makeRepo([makePack()])
    const error = Object.assign(new Error('400'), { code: 400, description: 'Bad Request: STICKERSET_INVALID' })
    const outcome = await sweeper(repo, makeTelegram({ getError: error })).tick()
    assert.deepStrictEqual(outcome, { gone: 1 })
    assert.deepStrictEqual(repo.cleared, ['pack_by_bot'])
  })

  await test('a Telegram 502 reschedules soon and does not use up a look', async () => {
    const repo = makeRepo([makePack({ placeholderChecks: 2 })])
    const error = Object.assign(new Error('502'), { code: 502, description: 'Bad Gateway' })
    const outcome = await sweeper(repo, makeTelegram({ getError: error })).tick()
    assert.deepStrictEqual(outcome, { error: 1 })
    assert.deepStrictEqual(repo.rescheduled, [{ name: 'pack_by_bot', at: new Date(NOW + RETRY_AFTER_ERROR_MS), checks: 2 }])
  })

  await test('a failed delete with real stickers present is retried soon', async () => {
    const repo = makeRepo([makePack({ placeholderChecks: 1 })])
    const deleteError = Object.assign(new Error('400'), { code: 400, description: 'Bad Request: STICKERSET_NOT_MODIFIED' })
    const outcome = await sweeper(repo, makeTelegram({ set: { stickers: [ph, real(1)] }, deleteError })).tick()
    assert.deepStrictEqual(outcome, { retry: 1 })
    assert.deepStrictEqual(repo.rescheduled, [{ name: 'pack_by_bot', at: new Date(NOW + RETRY_AFTER_ERROR_MS), checks: 2 }])
  })

  await test('a delete that keeps failing stops after the last look', async () => {
    const repo = makeRepo([makePack({ placeholderChecks: CHECK_DELAYS_MS.length - 1 })])
    const deleteError = Object.assign(new Error('400'), { code: 400, description: 'Bad Request: STICKERSET_NOT_MODIFIED' })
    await sweeper(repo, makeTelegram({ set: { stickers: [ph, real(1)] }, deleteError })).tick()
    assert.deepStrictEqual(repo.rescheduled, [{ name: 'pack_by_bot', at: null, checks: CHECK_DELAYS_MS.length }])
  })

  await test('packs not yet due are not touched', async () => {
    const repo = makeRepo([makePack({ placeholderCheckAt: new Date(NOW + 60000) })])
    const telegram = makeTelegram({ set: { stickers: [ph, real(1)] } })
    const outcome = await sweeper(repo, telegram).tick()
    assert.deepStrictEqual(outcome, {})
    assert.strictEqual(telegram.calls.length, 0)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('placeholder-sweeper test OK')
}

main()
