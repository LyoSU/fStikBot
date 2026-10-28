// Unit tests for pack-ops/execute.js: the publish state machine against an
// in-memory Telegram that can fail on any call, three ways:
//   lost     the request never reached Telegram (network error)
//   noreply  Telegram applied it, the answer got lost (network error)
//   crash    the process dies mid-step: nothing after the step's `running`
//            write is persisted, and the lock is left behind
// After every fault the commit is resumed from what the store last saved,
// and the pack must end up exactly as the draft — no duplicates, nothing
// lost, nothing extra.

const assert = require('assert')
const { runCommit, newCommit } = require('../pack-ops/execute')
const { mergeOutside } = require('../pack-ops/plan')

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

function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
const telegramError = (code, description) => Object.assign(new Error(description), { code, description })

class Crash extends Error {}

// In-memory Telegram with the measured semantics (plan 7.1), including the
// merge of a file already in the pack: an add of it does nothing, a replace
// with it moves the existing sticker into place. An uploaded file makes the
// same sticker every time: added again after its sticker was deleted, it comes
// back under the old file_unique_id (measured). `sources` names the file each
// initial sticker was made from.
//
// `outOfBand(change)` edits the pack the way a Telegram app does: getStickerSet
// keeps answering with the pack as it was until this bot's next write that
// succeeds (the Bot API's copy, measured), and a delete of a sticker that is
// gone answers STICKERSET_NOT_MODIFIED. `pack.gone` is a deleted set.
function fakeTelegram (initial, world, { sources = {} } = {}) {
  let fresh = 0
  const pack = { title: 'Old title', thumbnail: null, gone: false, stickers: initial.map((uid) => ({ uid, from: sources[uid], emoji: ['🙂'], keywords: [] })) }
  const byFileId = (fileId) => pack.stickers.find((s) => `fid:${s.uid}` === fileId)
  const madeFrom = new Map(Object.entries(sources).map(([uid, from]) => [from, uid]))
  const stickerOf = (from) => {
    if (!madeFrom.has(from)) madeFrom.set(from, `new${++fresh}`)
    return madeFrom.get(from)
  }
  const calls = []
  let cached = null

  const read = () => ({
    title: pack.title,
    ...(pack.thumbnail ? { thumbnail: { file_id: 'thumb' } } : {}),
    stickers: pack.stickers.map((s) => ({ file_unique_id: s.uid, file_id: `fid:${s.uid}`, custom_emoji_id: `ce:${s.uid}`, format: 'static' }))
  })

  const apply = {
    getStickerSet: () => cached || read(),
    setStickerSetTitle: ({ title }) => { pack.title = title; return true },
    setStickerSetThumbnail: ({ thumbnail, format }) => {
      pack.thumbnail = thumbnail ? { format, bytes: thumbnail.source.toString(), filename: thumbnail.filename } : null
      return true
    },
    setCustomEmojiStickerSetThumbnail: ({ custom_emoji_id: id }) => { pack.thumbnail = id ? { customEmojiId: id } : null; return true },
    deleteStickerFromSet: ({ sticker }) => {
      const s = byFileId(sticker)
      if (!s) throw telegramError(400, 'Bad Request: STICKERSET_NOT_MODIFIED')
      pack.stickers.splice(pack.stickers.indexOf(s), 1)
      return true
    },
    replaceStickerInSet: ({ old_sticker: old, sticker }) => {
      const s = byFileId(old)
      if (!s) throw telegramError(400, 'Bad Request: STICKER_INVALID')
      if (s.from === sticker.sticker) return true
      const same = pack.stickers.find((x) => x.from === sticker.sticker)
      if (same) {
        pack.stickers.splice(pack.stickers.indexOf(same), 1)
        pack.stickers[pack.stickers.indexOf(s)] = same
        return true
      }
      pack.stickers[pack.stickers.indexOf(s)] = { uid: stickerOf(sticker.sticker), from: sticker.sticker, emoji: sticker.emoji_list, keywords: sticker.keywords || [] }
      return true
    },
    addStickerToSet: ({ sticker }) => {
      if (pack.stickers.some((x) => x.from === sticker.sticker)) return true
      pack.stickers.push({ uid: stickerOf(sticker.sticker), from: sticker.sticker, emoji: sticker.emoji_list, keywords: sticker.keywords || [] })
      return true
    },
    setStickerPositionInSet: ({ sticker, position }) => {
      const s = byFileId(sticker)
      if (!s) throw telegramError(400, 'Bad Request: STICKER_INVALID')
      pack.stickers.splice(pack.stickers.indexOf(s), 1)
      pack.stickers.splice(position, 0, s)
      return true
    },
    setStickerEmojiList: ({ sticker, emoji_list: emojiList }) => { byFileId(sticker).emoji = emojiList; return true },
    setStickerKeywords: ({ sticker, keywords }) => { byFileId(sticker).keywords = keywords; return true }
  }

  return {
    pack,
    calls,
    outOfBand (change) {
      cached = cached || read()
      change(pack)
    },
    async callApi (method, params) {
      const index = calls.length
      calls.push(method)
      const fault = world.faultAt === index ? world.fault : null
      if (fault === 'lost') throw networkError()
      if (fault === 'crash-before') { world.crashed = true; throw new Crash('crash') }
      if (pack.gone && !(method === 'getStickerSet' && cached)) throw telegramError(400, 'Bad Request: STICKERSET_INVALID')
      const result = JSON.parse(JSON.stringify(apply[method](params)))
      if (method !== 'getStickerSet') cached = null
      if (fault === 'noreply') throw networkError()
      if (fault === 'crash-after') { world.crashed = true; throw new Crash('crash') }
      return result
    }
  }
}

// Persists deep copies; refuses writes once the process "died".
function fakeStore (world) {
  return {
    saved: null,
    async save (commit) {
      if (world.crashed) throw new Crash('dead process cannot write')
      this.saved = JSON.parse(JSON.stringify(commit))
    }
  }
}

function fakeLock (world) {
  const held = new Map()
  return {
    held,
    async acquire (name) {
      if (held.has(name)) return null
      const token = Math.random().toString(36)
      held.set(name, token)
      return token
    },
    async extend (name, token) { return held.get(name) === token },
    async release (name, token) {
      if (world.crashed) return // a dead process releases nothing
      if (held.get(name) === token) held.delete(name)
    },
    expire (name) { held.delete(name) } // the TTL running out
  }
}

// A Telegram where the pack does not exist until createNewStickerSet makes it.
// Pack methods go to an inner single-pack fake; `foreign` names belong to
// someone else. Faults count over the outer calls.
function fakeCreatingTelegram (world, { foreign = [] } = {}) {
  const inner = fakeTelegram([], { faultAt: -1 })
  const calls = []
  const created = { name: null, times: 0 }
  const taken = new Set(foreign)

  return {
    pack: inner.pack,
    calls,
    created,
    async callApi (method, params) {
      const index = calls.length
      calls.push(method)
      const fault = world.faultAt === index ? world.fault : null
      if (fault === 'lost') throw networkError()
      if (fault === 'crash-before') { world.crashed = true; throw new Crash('crash') }

      let result
      if (method === 'getStickerSet' && (taken.has(params.name) || params.name !== created.name)) {
        if (!taken.has(params.name)) throw telegramError(400, 'Bad Request: STICKERSET_INVALID')
        result = { title: 'Somebody else', stickers: [{ file_unique_id: 'foreign', file_id: 'fid:foreign', format: 'static' }] }
      } else if (method === 'createNewStickerSet') {
        if (taken.has(params.name) || created.name) throw telegramError(400, 'Bad Request: sticker set name is already occupied')
        created.name = params.name
        created.times++
        created.params = params
        inner.pack.title = params.title
        inner.pack.stickers = params.stickers.map((st, i) => ({ uid: `c${i}`, from: st.sticker, emoji: st.emoji_list, keywords: st.keywords || [] }))
        result = true
      } else {
        result = await inner.callApi(method, params)
      }
      result = JSON.parse(JSON.stringify(result))
      if (fault === 'noreply') throw networkError()
      if (fault === 'crash-after') { world.crashed = true; throw new Crash('crash') }
      return result
    }
  }
}

const ids = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

function randomDraft (base, rand, tag) {
  const draft = []
  for (const uid of base) {
    const roll = rand()
    if (roll < 0.2) continue
    const item = { assetId: `a-${uid}`, fileUniqueId: uid, emojiList: ['🙂'] }
    if (roll < 0.35) item.file = { fileId: `upload:${tag}:${uid}` }
    else if (roll < 0.45) item.emojiList = ['😀', '🙂']
    else if (roll < 0.5) item.keywords = ['cat']
    draft.push(item)
  }
  const adds = Math.floor(rand() * 4)
  for (let i = 0; i < adds; i++) {
    draft.splice(Math.floor(rand() * (draft.length + 1)), 0, { assetId: `n-${tag}-${i}`, file: { fileId: `upload:${tag}:n${i}` }, emojiList: ['😀'] })
  }
  for (let i = draft.length - 1; i > 0; i--) {
    if (rand() < 0.3) {
      const j = Math.floor(rand() * (i + 1))
      ;[draft[i], draft[j]] = [draft[j], draft[i]]
    }
  }
  return draft
}

// The pack as the draft says it should be: content source per position.
function expectedContent (draft, initialPack) {
  return draft.map((item) => {
    if (item.file) return { from: item.file.fileId, emoji: item.emojiList }
    return { uid: item.fileUniqueId, emoji: item.emojiList, keywords: item.keywords }
  })
}

function assertPackMatches (pack, draft, label) {
  const want = expectedContent(draft)
  assert.strictEqual(pack.stickers.length, want.length, `${label}: ${pack.stickers.length} stickers, want ${want.length}`)
  want.forEach((w, i) => {
    const got = pack.stickers[i]
    if (w.from) assert.strictEqual(got.from, w.from, `${label}: position ${i} should hold ${w.from}, holds ${got.from || got.uid}`)
    else assert.strictEqual(got.uid, w.uid, `${label}: position ${i} should hold ${w.uid}, holds ${got.uid}`)
    assert.deepStrictEqual(got.emoji, w.emoji, `${label}: emoji at ${i}`)
    if (w.keywords) assert.deepStrictEqual(got.keywords, w.keywords, `${label}: keywords at ${i}`)
  })
}

// Runs the commit, resuming after every fault from the last saved state,
// until it settles. Returns the final commit.
async function runToEnd (initialCommit, tg, store, lock, world, deps = {}) {
  let commit = initialCommit
  for (let run = 0; run < 10; run++) {
    try {
      commit = await runCommit(commit, { telegram: tg, store, lock, ...deps })
    } catch (err) {
      if (!(err instanceof Crash)) throw err
    }
    if (world.crashed) {
      world.crashed = false
      lock.expire(commit.name)
      commit = JSON.parse(JSON.stringify(store.saved))
    }
    world.faultAt = -1
    if (['succeeded', 'conflict', 'failed'].includes(commit.status)) return commit
  }
  throw new Error(`commit did not settle: ${commit.status} ${commit.error}`)
}

;(async () => {
  console.log('pack-ops execute test')

  await test('a clean publish succeeds and records each step', async () => {
    const world = { faultAt: -1 }
    const base = ids(6, 's')
    const tg = fakeTelegram(base, world)
    const draft = randomDraft(base, rng(3), 't')
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.ok(commit.steps.every((s) => s.state === 'succeeded'))
    assertPackMatches(tg.pack, draft, 'clean')
  })

  await test('a second run while the pack is locked does nothing', async () => {
    const world = { faultAt: -1 }
    const lock = fakeLock(world)
    await lock.acquire('p')
    const tg = fakeTelegram(['x'], world)
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft: [] }), { telegram: tg, store: fakeStore(world), lock })
    assert.strictEqual(commit.status, 'pending')
    assert.strictEqual(tg.calls.length, 0)
  })

  await test('the pack lock outlives a call that waits longer than its TTL', async () => {
    const world = { faultAt: -1 }
    const t0 = Date.now()
    const virtualNow = () => (Date.now() - t0) * 3000 // 40 ms of real time = the 2 min TTL
    const rows = new Map()
    const lock = {
      async acquire (name, ttl) {
        const row = rows.get(name)
        if (row && row.expiresAt > virtualNow()) return null
        rows.set(name, { token: 't' + rows.size, expiresAt: virtualNow() + ttl })
        return rows.get(name).token
      },
      async extend (name, token, ttl) {
        const row = rows.get(name)
        if (!row || row.token !== token || row.expiresAt < virtualNow()) return false
        row.expiresAt = virtualNow() + ttl
        return true
      },
      async release (name, token) { if (rows.get(name)?.token === token) rows.delete(name) }
    }
    const tg = fakeTelegram(['x'], world)
    const real = tg.callApi.bind(tg)
    let slow = true
    tg.callApi = async (method, params) => {
      if (method === 'addStickerToSet' && slow) {
        slow = false
        await new Promise((resolve) => setTimeout(resolve, 120)) // 6 virtual minutes
      }
      return real(method, params)
    }
    const draft = [{ assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    const first = runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft }), { telegram: tg, store: fakeStore(world), lock, lockRenewMs: 10 })

    await new Promise((resolve) => setTimeout(resolve, 80)) // well past the TTL, mid-call
    const callsBefore = tg.calls.length
    const second = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft }), { telegram: tg, store: fakeStore(world), lock })
    assert.strictEqual(second.status, 'pending', 'no lock: the second run did nothing')
    assert.strictEqual(tg.calls.length, callsBefore)

    const done = await first
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(rows.size, 0, 'the lock is released and the renewal stopped')
  })

  await test('a refused step fails the commit and keeps what ran before it', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x', 'y'], world)
    const realAdd = tg.callApi.bind(tg)
    tg.callApi = (method, params) => method === 'addStickerToSet'
      ? Promise.reject(telegramError(400, 'Bad Request: STICKER_PNG_DIMENSIONS'))
      : realAdd(method, params)
    const draft = [{ assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x', 'y'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'failed')
    assert.match(commit.error, /STICKER_PNG_DIMENSIONS/)
    assert.deepStrictEqual(tg.pack.stickers.map((s) => s.uid), ['x'], 'the delete before it stays applied')
  })

  await test('a restored sticker whose file_id Telegram refuses goes in by the original upload\'s', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    const realAdd = tg.callApi.bind(tg)
    const sent = []
    tg.callApi = (method, params) => {
      if (method !== 'addStickerToSet') return realAdd(method, params)
      sent.push(params.sticker.sticker)
      return params.sticker.sticker === 'pack-fid'
        ? Promise.reject(telegramError(400, 'Bad Request: wrong file identifier'))
        : realAdd(method, params)
    }
    const draft = [
      { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] },
      { assetId: 'r', file: { restore: { fileUniqueId: 'old' }, fileId: 'pack-fid', fallbackFileId: 'orig-fid' }, emojiList: ['😀'] }
    ]
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.deepStrictEqual(sent, ['pack-fid', 'orig-fid'])
    assert.strictEqual(tg.pack.stickers.length, 2)
  })

  await test('a 5xx on a restored sticker is not retried with the fallback: it may have been added', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    const realAdd = tg.callApi.bind(tg)
    const sent = []
    tg.callApi = (method, params) => {
      if (method !== 'addStickerToSet') return realAdd(method, params)
      sent.push(params.sticker.sticker)
      return Promise.reject(telegramError(502, 'Bad Gateway'))
    }
    const draft = [
      { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] },
      { assetId: 'r', file: { restore: { fileUniqueId: 'old' }, fileId: 'pack-fid', fallbackFileId: 'orig-fid' }, emojiList: ['😀'] }
    ]
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.deepStrictEqual(sent, ['pack-fid'])
    assert.notStrictEqual(commit.status, 'succeeded')
  })

  await test('a 429 beyond the wait interrupts, and a rerun finishes', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    const real = tg.callApi.bind(tg)
    let limited = true
    tg.callApi = (method, params) => {
      if (method === 'addStickerToSet' && limited) {
        limited = false
        return Promise.reject(Object.assign(telegramError(429, 'Too Many Requests: retry after 400'), { parameters: { retry_after: 400 } }))
      }
      return real(method, params)
    }
    const draft = [{ assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    const store = fakeStore(world)
    const lock = fakeLock(world)
    let commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x'], draft }), { telegram: tg, store, lock })
    assert.strictEqual(commit.status, 'interrupted')
    commit = await runCommit(commit, { telegram: tg, store, lock })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assertPackMatches(tg.pack, draft, '429')
  })

  // Two draft items with the same uploaded file: Telegram keeps one sticker for
  // both, and the publish goes on without the second.
  for (const kind of ['add', 'replace']) {
    for (const fault of [null, 'lost', 'noreply', 'crash-before', 'crash-after']) {
      await test(`a duplicate file in a ${kind} is left out and the rest is published${fault ? ` (with a "${fault}" fault on it)` : ''}`, async () => {
        const base = ['x', 'y', 'z']
        const draft = kind === 'add'
          ? [
              { assetId: 'first', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['😎'] },
              { assetId: 'second', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'third', file: { fileId: 'upload:other' }, emojiList: ['🐱'] }
            ]
          : [
              { assetId: 'a-z', fileUniqueId: 'z', emojiList: ['😎'] },
              { assetId: 'a-x', fileUniqueId: 'x', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'a-y', fileUniqueId: 'y', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'third', file: { fileId: 'upload:other' }, emojiList: ['🐱'] }
            ]
        const published = draft.filter((item) => item.assetId !== (kind === 'add' ? 'second' : 'a-y'))
        // Where is the call carrying the duplicate? Probe a clean run.
        const probeWorld = { faultAt: -1 }
        const probe = fakeTelegram(base, probeWorld)
        const plain = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld) })
        assert.strictEqual(plain.status, 'succeeded', plain.error)
        // The duplicate is the second add / the second replace.
        const method = kind === 'add' ? 'addStickerToSet' : 'replaceStickerInSet'
        const target = probe.calls.map((m, i) => [m, i]).filter(([m]) => m === method)[1][1]

        const world = { faultAt: fault ? target : -1, fault }
        const tg = fakeTelegram(base, world)
        const store = fakeStore(world)
        const lock = fakeLock(world)
        const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), tg, store, lock, world)
        assert.strictEqual(commit.status, 'succeeded', `${commit.status} ${commit.error}`)
        assert.deepStrictEqual(commit.steps.filter((step) => step.merged).map((step) => step.assetId), [kind === 'add' ? 'second' : 'a-y'])
        assertPackMatches(tg.pack, published, 'merged')
        assert.strictEqual(commit.mapping[kind === 'add' ? 'second' : 'a-y'], undefined, 'a merged item has no sticker of its own')
      })
    }
  }

  for (const fault of [null, 'lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a deleted sticker's file added back returns under its old id${fault ? ` (a "${fault}" fault on every call)` : ''}`, async () => {
      // The user dropped y and added the file y was made from (a replace done
      // as delete + add): Telegram hands back y itself.
      const base = ['x', 'y']
      const draft = [
        { assetId: 'n', file: { fileId: 'upload:y' }, emojiList: ['😀'] },
        { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] }
      ]
      const probeWorld = { faultAt: -1 }
      const probe = fakeTelegram(base, probeWorld, { sources: { y: 'upload:y' } })
      await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld) })
      for (let at = 0; at < (fault ? probe.calls.length : 1); at++) {
        const world = { faultAt: fault ? at : -1, fault }
        const tg = fakeTelegram(base, world, { sources: { y: 'upload:y' } })
        const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), tg, fakeStore(world), fakeLock(world), world)
        assert.strictEqual(commit.status, 'succeeded', `at ${at}: ${commit.error}`)
        assert.deepStrictEqual(tg.pack.stickers.map((st) => st.uid), ['y', 'x'])
        assert.strictEqual(commit.mapping.n, 'y')
        assertPackMatches(tg.pack, draft, `at ${at}`)
      }
    })
  }

  for (const fault of [null, 'lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a sticker replaced with the file it was made from stays itself${fault ? ` (a "${fault}" fault on every call)` : ''}`, async () => {
      const base = ['x', 'y']
      const draft = [
        { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] },
        { assetId: 'a-y', fileUniqueId: 'y', file: { fileId: 'upload:y' }, emojiList: ['🙂'] }
      ]
      const probeWorld = { faultAt: -1 }
      const probe = fakeTelegram(base, probeWorld, { sources: { y: 'upload:y' } })
      await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld) })
      for (let at = 0; at < (fault ? probe.calls.length : 1); at++) {
        const world = { faultAt: fault ? at : -1, fault }
        const tg = fakeTelegram(base, world, { sources: { y: 'upload:y' } })
        const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), tg, fakeStore(world), fakeLock(world), world)
        assert.strictEqual(commit.status, 'succeeded', `at ${at}: ${commit.error}`)
        assert.deepStrictEqual(tg.pack.stickers.map((st) => st.uid), ['x', 'y'])
        assert.strictEqual(commit.mapping['a-y'], 'y')
      }
    })
  }

  await test('a sticker deleted in a Telegram app: done once the pack shows it gone', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['a', 'b', 'c'], world)
    tg.outOfBand((pack) => pack.stickers.splice(1, 1)) // b, deleted in the app
    const draft = [{ assetId: 'a-c', fileUniqueId: 'c', emojiList: ['🙂'] }]
    // The draft was opened on the old copy, which the bot still gets.
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a', 'b', 'c'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    // Deleting a refreshed the copy, so b's NOT_MODIFIED is confirmed.
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.deepStrictEqual(tg.pack.stickers.map((st) => st.uid), ['c'])
  })

  // A pack edited outside (a Telegram app) after the draft was opened, while
  // the Bot API's copy still shows it as it was: the draft is carried over to
  // the pack as the server has it (plan.js mergeOutside).
  const serverUids = (tg) => async () => tg.pack.stickers.map((st) => st.uid)

  await test('a pack changed outside: the draft goes onto the pack as the server has it', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['a', 'b', 'c', 'd'], world)
    tg.outOfBand((pack) => {
      pack.stickers.splice(1, 1) // b deleted in the app
      pack.stickers.push({ uid: 'o1', from: 'outside', emoji: ['🐶'], keywords: [] }) // and one added
    })
    // The user, on the old copy: drops d, moves c first, relabels a, adds one at the end.
    const draft = [
      { assetId: 'a-c', fileUniqueId: 'c', emojiList: ['🙂'] },
      { assetId: 'a-a', fileUniqueId: 'a', emojiList: ['😀'] },
      { assetId: 'a-b', fileUniqueId: 'b', emojiList: ['🙂'] },
      { assetId: 'n', file: { fileId: 'up:n' }, emojiList: ['🐱'] }
    ]
    const known = { a: { emojiList: ['🙂'] }, b: { emojiList: ['🙂'] }, c: { emojiList: ['🙂'] }, d: { emojiList: ['🙂'] } }
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a', 'b', 'c', 'd'], draft, known }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), freshUids: serverUids(tg) })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    // o1 was last: it stays after the pack's own stickers, before the new one.
    assert.deepStrictEqual(tg.pack.stickers.map((st) => (st.from && st.from !== 'outside' ? st.from : st.uid)), ['c', 'a', 'o1', 'up:n'])
    assert.deepStrictEqual(tg.pack.stickers.find((st) => st.uid === 'a').emoji, ['😀'])
    assert.deepStrictEqual(tg.pack.stickers.find((st) => st.uid === 'o1').emoji, ['🐶'], 'an outside sticker is left as it is')
    assert.deepStrictEqual(commit.outside, { deleted: ['b'], added: ['o1'] })
    assert.deepStrictEqual(commit.draft, draft, 'the draft as sent stays for the job view')
  })

  await test('a pack changed outside where the draft touched the same sticker: a conflict with the fresh pack, untouched', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['a', 'b'], world)
    tg.outOfBand((pack) => pack.stickers.splice(1, 1)) // b deleted in the app
    const draft = [{ assetId: 'a-a', fileUniqueId: 'a', emojiList: ['🙂'] }, { assetId: 'a-b', fileUniqueId: 'b', file: { fileId: 'up:b' }, emojiList: ['🙂'] }]
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a', 'b'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), freshUids: serverUids(tg) })
    assert.strictEqual(commit.status, 'conflict')
    assert.strictEqual(commit.error, 'the pack changed outside the draft')
    assert.deepStrictEqual(commit.fresh, ['a'])
    assert.deepStrictEqual(commit.conflicts, [{ fileUniqueId: 'b', reason: 'replaced in the draft, deleted outside' }])
    assert.deepStrictEqual(tg.calls, ['getStickerSet'])
  })

  await test('the same draft published again over a lagging copy now succeeds instead of looping', async () => {
    // Prod: 7 publishes in 7 minutes with one base, each a conflict, because
    // reloading through the API gave the same old copy every time.
    const world = { faultAt: -1 }
    const base = ['a', 'b', 'c', 'd', 'e']
    const tg = fakeTelegram(base, world)
    tg.outOfBand((pack) => pack.stickers.push({ uid: 'o1', from: 'outside', emoji: ['🐶'], keywords: [] }))
    const draft = base.map((uid) => ({ assetId: `a-${uid}`, fileUniqueId: uid, emojiList: ['🙂'] }))
    draft.push({ assetId: 'n', file: { fileId: 'up:n' }, emojiList: ['🐱'] })
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), freshUids: serverUids(tg) })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.deepStrictEqual(tg.pack.stickers.map((st) => st.uid), ['a', 'b', 'c', 'd', 'e', 'o1', commit.mapping.n])
  })

  for (const fresh of [false, true]) {
    await test(`a delete of a sticker already gone is done, and the publish goes on${fresh ? ' (with a fresh read)' : ''}`, async () => {
      const world = { faultAt: -1 }
      const tg = fakeTelegram(['a', 'b', 'c'], world)
      // Deleted elsewhere after the plan saw it: the delete meets it gone,
      // while the copy goes on showing it.
      const real = tg.callApi.bind(tg)
      tg.callApi = async (method, params) => {
        if (method === 'deleteStickerFromSet' && params.sticker === 'fid:b') tg.outOfBand((pack) => pack.stickers.splice(1, 1))
        return real(method, params)
      }
      const draft = [{ assetId: 'a-c', fileUniqueId: 'c', emojiList: ['🙂'] }, { assetId: 'a-a', fileUniqueId: 'a', emojiList: ['🙂'] }]
      const deps = { telegram: tg, store: fakeStore(world), lock: fakeLock(world), ...(fresh ? { freshUids: serverUids(tg) } : {}) }
      const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a', 'b', 'c'], draft }), deps)
      assert.strictEqual(commit.status, 'succeeded', commit.error)
      assert.strictEqual(commit.steps.find((step) => step.kind === 'delete').alreadyGone, true)
      assert.deepStrictEqual(tg.pack.stickers.map((st) => st.uid), ['c', 'a'])
    })
  }

  for (const fault of ['lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a "${fault}" fault on every call of 60 publishes over packs changed outside ends as the merge says`, async () => {
      const rand = rng(fault.length * 7919)
      let runs = 0
      let conflicts = 0
      for (let round = 0; round < 60; round++) {
        const base = ids(2 + Math.floor(rand() * 6), `m${round}-`)
        const draft = randomDraft(base, rand, `${fault}m${round}`)
        // One outside change per round: some deleted, some added anywhere.
        const changed = base.filter(() => rand() >= 0.2).map((uid) => ({ uid, emoji: ['🙂'], keywords: [] }))
        const added = Math.floor(rand() * 3)
        for (let i = 0; i < added; i++) {
          changed.splice(Math.floor(rand() * (changed.length + 1)), 0, { uid: `o${round}-${i}`, from: `outside:${round}:${i}`, emoji: ['🐶'], keywords: [] })
        }
        const known = Object.fromEntries(base.map((uid) => [uid, { emojiList: ['🙂'] }]))
        const merged = mergeOutside(base, changed.map((st) => st.uid), draft, new Map(Object.entries(known)))
        const setup = (world) => {
          const tg = fakeTelegram(base, world)
          tg.outOfBand((pack) => { pack.stickers = changed.map((st) => ({ ...st })) })
          return tg
        }

        const probeWorld = { faultAt: -1 }
        const probe = setup(probeWorld)
        const plain = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft, known }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld), freshUids: serverUids(probe) })
        if (merged.conflicts) {
          assert.strictEqual(plain.status, 'conflict', `round ${round}`)
          conflicts++
          continue
        }
        const want = merged.draft.map((item) => (item.file ? item.file.fileId : item.fileUniqueId))

        for (let at = 0; at < probe.calls.length; at++) {
          const world = { faultAt: at, fault }
          const tg = setup(world)
          const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft, known }), tg, fakeStore(world), fakeLock(world), world, { freshUids: serverUids(tg) })
          const label = `round ${round}, ${fault} at call ${at} (${probe.calls[at]})`
          assert.strictEqual(commit.status, 'succeeded', `${label}: ${commit.status} ${commit.error}`)
          assert.deepStrictEqual(tg.pack.stickers.map((st) => (st.from && !st.from.startsWith('outside') ? st.from : st.uid)), want, label)
          runs++
        }
      }
      assert.ok(runs > 100 && conflicts < 60, `${runs} faulted runs, ${conflicts} conflicts`)
    })
  }

  await test('a fresh read that is unknown or fails leaves the conflict check to the Bot API\'s copy', async () => {
    for (const freshUids of [async () => null, async () => { throw new Error('mtproto down') }]) {
      const world = { faultAt: -1 }
      const tg = fakeTelegram(['a', 'b'], world)
      const draft = [{ assetId: 'a-a', fileUniqueId: 'a', emojiList: ['🙂'] }]
      const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a', 'b'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), freshUids })
      assert.strictEqual(commit.status, 'succeeded', commit.error)
    }
  })

  await test('a pack deleted in Telegram: confirmed by a fresh read, the commit says the pack is gone', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['a'], world)
    tg.outOfBand((pack) => { pack.gone = true })
    const draft = [{ assetId: 'a-a', fileUniqueId: 'a', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    const readFresh = async () => { throw telegramError(400, 'Bad Request: STICKERSET_INVALID') }
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), readFresh })
    assert.strictEqual(commit.status, 'failed')
    assert.strictEqual(commit.packGone, true)
    assert.match(commit.error, /^pack_gone: .*STICKERSET_INVALID/)
  })

  await test('STICKERSET_INVALID on a pack that is still there (another bot\'s, or not confirmed) is a plain failure', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['a'], world)
    tg.outOfBand((pack) => { pack.gone = true })
    const draft = [{ assetId: 'a-a', fileUniqueId: 'a', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    // No fresh read: getStickerSet still serves the old copy.
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['a'], draft }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'failed')
    assert.strictEqual(commit.packGone, undefined)
    assert.strictEqual(commit.error, 'Bad Request: STICKERSET_INVALID')
  })

  for (const fault of ['lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a "${fault}" fault on every call of 150 random publishes recovers exactly`, async () => {
      const rand = rng(fault.length * 101)
      let runs = 0
      for (let round = 0; round < 150; round++) {
        const base = ids(1 + Math.floor(rand() * 8), `r${round}-`)
        const draft = randomDraft(base, rand, `${fault}${round}`)

        // How many calls does a clean run take? Fault each one in turn.
        const probeWorld = { faultAt: -1 }
        const probe = fakeTelegram(base, probeWorld)
        await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld) })

        for (let at = 0; at < probe.calls.length; at++) {
          const world = { faultAt: at, fault }
          const tg = fakeTelegram(base, world)
          const store = fakeStore(world)
          const lock = fakeLock(world)
          const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), tg, store, lock, world)
          const label = `round ${round}, ${fault} at call ${at} (${probe.calls[at]})`
          assert.strictEqual(commit.status, 'succeeded', `${label}: ${commit.status} ${commit.error}`)
          assertPackMatches(tg.pack, draft, label)
          runs++
        }
      }
      assert.ok(runs > 500, `only ${runs} faulted runs`)
    })
  }

  // Pack settings: title and thumbnail, set after the stickers are in place.
  const keepAll = (base) => base.map((uid) => ({ assetId: `k:${uid}`, fileUniqueId: uid, emojiList: ['🙂'] }))
  const assets = {
    load: async (id) => (id === 'missing' ? null : { format: 'static', data: Buffer.from(`bytes of ${id}`) })
  }
  const formatTitle = async (commit, title) => `${title} :: @bot`
  const settingsCommit = (settings, { base = ['x', 'y'], packType } = {}) =>
    newCommit({ name: 'p', ownerTelegramId: 7, base, draft: keepAll(base), settings, packType })

  await test('a settings-only commit sets the formatted title and uploads the thumbnail', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x', 'y'], world)
    const commit = await runCommit(settingsCommit({ title: 'New', thumbnail: { assetId: 'a1' } }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), assets, formatTitle })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(tg.pack.title, 'New :: @bot')
    assert.deepStrictEqual(tg.pack.thumbnail, { format: 'static', bytes: 'bytes of a1', filename: 'thumbnail.webp' })
    assert.deepStrictEqual(tg.pack.stickers.map((s) => s.uid), ['x', 'y'])
    assert.deepStrictEqual(commit.steps.filter((s) => s.phase === 'settings').map((s) => [s.phase, s.kind, s.state]), [['settings', 'title', 'succeeded'], ['settings', 'thumbnail', 'succeeded']])
  })

  await test('a title the pack already has is not sent again', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    tg.pack.title = 'Same :: @bot'
    const commit = await runCommit(settingsCommit({ title: 'Same' }, { base: ['x'] }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), formatTitle })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.ok(!tg.calls.includes('setStickerSetTitle'))
  })

  await test('Telegram saying "not modified" counts as done', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    const real = fakeTelegram(['x'], world)
    tg.callApi = (method, params) => method === 'setStickerSetTitle'
      ? Promise.reject(telegramError(400, 'Bad Request: STICKERSET_NOT_MODIFIED'))
      : real.callApi(method, params)
    const commit = await runCommit(settingsCommit({ title: 'T' }, { base: ['x'] }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), formatTitle })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
  })

  await test('dropping the thumbnail of a pack that has none sends nothing', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x'], world)
    const commit = await runCommit(settingsCommit({ thumbnail: null }, { base: ['x'] }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.ok(!tg.calls.includes('setStickerSetThumbnail'))
    tg.pack.thumbnail = { format: 'static' }
    const again = await runCommit(settingsCommit({ thumbnail: null }, { base: ['x'] }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(again.status, 'succeeded', again.error)
    assert.strictEqual(tg.pack.thumbnail, null)
  })

  await test('a custom emoji pack takes its thumbnail from one of its stickers, and can drop it', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x', 'y'], world)
    const run = (settings) => runCommit(settingsCommit(settings, { packType: 'custom_emoji' }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual((await run({ thumbnail: { fromSticker: 'y' } })).status, 'succeeded')
    assert.deepStrictEqual(tg.pack.thumbnail, { customEmojiId: 'ce:y' })
    assert.strictEqual((await run({ thumbnail: null })).status, 'succeeded')
    assert.strictEqual(tg.pack.thumbnail, null)
  })

  await test('settings that cannot apply fail the commit with a reason', async () => {
    for (const [label, settings, packType, want] of [
      ['missing asset', { thumbnail: { assetId: 'missing' } }, 'regular', /asset_missing/],
      ['sticker thumbnail on a regular pack', { thumbnail: { fromSticker: 'x' } }, 'regular', /uploaded file/],
      ['upload on an emoji pack', { thumbnail: { assetId: 'a1' } }, 'custom_emoji', /takes its thumbnail from a sticker/],
      ['sticker gone', { thumbnail: { fromSticker: 'gone' } }, 'custom_emoji', /no custom emoji id/]
    ]) {
      const world = { faultAt: -1 }
      const tg = fakeTelegram(['x'], world)
      const commit = await runCommit(settingsCommit(settings, { base: ['x'], packType }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), assets })
      assert.strictEqual(commit.status, 'failed', label)
      assert.match(commit.error, want, label)
    }
  })

  await test('stickers and settings in one commit: settings run last, on the final pack', async () => {
    const world = { faultAt: -1 }
    const base = ['x', 'y']
    const tg = fakeTelegram(base, world)
    const draft = [{ assetId: 'a-y', fileUniqueId: 'y', emojiList: ['🙂'] }, { assetId: 'n', file: { fileId: 'up' }, emojiList: ['😀'] }]
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 7, base, draft, settings: { title: 'Mixed' }, packType: 'custom_emoji' }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world), formatTitle })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(tg.pack.title, 'Mixed :: @bot')
    assert.ok(tg.calls.indexOf('setStickerSetTitle') > tg.calls.lastIndexOf('addStickerToSet'))
  })

  for (const fault of ['lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a "${fault}" fault on every call of a settings publish recovers exactly`, async () => {
      const mk = () => settingsCommit({ title: 'Faulty', thumbnail: { assetId: 'a1' } })
      const probeWorld = { faultAt: -1 }
      const probe = fakeTelegram(['x', 'y'], probeWorld)
      await runCommit(mk(), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld), assets, formatTitle })
      assert.ok(probe.calls.includes('setStickerSetThumbnail'))
      for (let at = 0; at < probe.calls.length; at++) {
        const world = { faultAt: at, fault }
        const tg = fakeTelegram(['x', 'y'], world)
        const label = `${fault} at call ${at} (${probe.calls[at]})`
        let commit = mk()
        const store = fakeStore(world)
        const lock = fakeLock(world)
        for (let run = 0; run < 10; run++) {
          try {
            commit = await runCommit(commit, { telegram: tg, store, lock, assets, formatTitle })
          } catch (err) {
            if (!(err instanceof Crash)) throw err
          }
          if (world.crashed) {
            world.crashed = false
            lock.expire(commit.name)
            commit = JSON.parse(JSON.stringify(store.saved))
          }
          world.faultAt = -1
          if (commit.status === 'succeeded') break
        }
        assert.strictEqual(commit.status, 'succeeded', `${label}: ${commit.status} ${commit.error}`)
        assert.strictEqual(tg.pack.title, 'Faulty :: @bot', label)
        assert.strictEqual(tg.pack.thumbnail?.bytes, 'bytes of a1', label)
      }
    })
  }

  // Creating a pack
  const botUsername = async () => 'bot'
  const fresh = (n) => Array.from({ length: n }, (_, i) => ({ assetId: `a:${i}`, file: { studioAssetId: `s${i}`, format: 'static', fileId: `up${i}` }, emojiList: [i === 0 ? '😀' : '🙂'], ...(i === 1 ? { keywords: ['cat'] } : {}) }))
  const createCommit = (n, create = {}) => newCommit({
    name: '~new:1', ownerTelegramId: 7, base: [], draft: fresh(n), packType: 'regular', create: { title: 'My Cats', ...create }
  })
  const createDeps = (world, extra = {}) => {
    const registered = []
    return {
      deps: { store: fakeStore(world), lock: fakeLock(world), formatTitle, botUsername, register: async (c) => { registered.push(c.name); return 'doc1' }, ...extra },
      registered
    }
  }

  await test('creating a pack: named like the wizard, titled with the bot suffix, first stickers in one call', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps, registered } = createDeps(world)
    const commit = await runCommit(createCommit(3), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(commit.name, 'My_Cats_by_bot')
    assert.strictEqual(tg.created.params.title, 'My Cats :: @bot')
    assert.strictEqual(tg.created.params.sticker_type, 'regular')
    assert.strictEqual(tg.created.params.user_id, 7)
    assert.deepStrictEqual(tg.created.params.stickers.map((st) => st.sticker), ['up0', 'up1', 'up2'])
    assert.deepStrictEqual(tg.created.params.stickers[1].keywords, ['cat'])
    assert.ok(!tg.calls.includes('addStickerToSet'))
    assert.deepStrictEqual(registered, ['My_Cats_by_bot'])
    assert.strictEqual(commit.stickerSet, 'doc1')
    assert.deepStrictEqual(commit.base, ['c0', 'c1', 'c2'])
    assert.deepStrictEqual(commit.draft.map((item) => commit.mapping[item.assetId]), ['c0', 'c1', 'c2'])
    // The seeded stickers already carry their emoji: nothing is set again.
    assert.ok(!tg.calls.includes('setStickerEmojiList') && !tg.calls.includes('setStickerKeywords'))
    assert.strictEqual(commit.lockName, '~new:1')
    assert.strictEqual(commit.create.seeded, 3)
  })

  await test('creating a pack: more than 50 stickers, the rest are added in order', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const commit = await runCommit(createCommit(54), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(tg.created.params.stickers.length, 50)
    assert.strictEqual(tg.calls.filter((m) => m === 'addStickerToSet').length, 4)
    assert.deepStrictEqual(tg.pack.stickers.slice(50).map((st) => st.from), ['up50', 'up51', 'up52', 'up53'])
  })

  await test('creating a pack: an emoji pack and repainting go to Telegram', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const commit = await runCommit(newCommit({ name: '~new:2', ownerTelegramId: 7, base: [], draft: fresh(1), packType: 'custom_emoji', create: { title: 'Mono', needsRepainting: true } }), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(tg.created.params.sticker_type, 'custom_emoji')
    assert.strictEqual(tg.created.params.needs_repainting, true)
  })

  await test('creating a pack: a title with a boost has no suffix and a long title is cut like the wizard cuts it', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const commit = createCommit(1, { title: 'A'.repeat(40) })
    const done = await runCommit(commit, { telegram: tg, ...deps, formatTitle: async (c, t) => `${t.slice(0, 30)} :: @bot` })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(tg.created.params.title, `${'A'.repeat(30)} :: @bot`)
  })

  await test('creating a copy: it starts with Boost, yet its first title carries the suffix like the wizard\'s', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const boosted = async (c, t) => (c.boost ? t : `${t} :: @bot`)
    const commit = { ...createCommit(2), boost: true }
    const done = await runCommit(commit, { telegram: tg, ...deps, formatTitle: boosted })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(tg.created.params.title, 'My Cats :: @bot')
    assert.strictEqual(done.boost, true)
  })

  await test('creating a copy: Boost only for a copy that is one (all from the set, or paid for)', async () => {
    const { copyEarnsBoost } = require('../pack-ops/execute')
    const copied = (n, set = 'cats') => Array.from({ length: n }, (_, i) => ({ assetId: `c:s${i}`, file: { copy: { set, fileUniqueId: `s${i}` }, format: 'static', fileId: `f${i}` }, emojiList: ['🙂'] }))
    const copy = (draft, extra = {}) => ({ boost: true, create: { title: 'x', copyOf: 'Cats' }, draft, ...extra })
    assert.strictEqual(copyEarnsBoost(copy(copied(2))), true, 'same type, every sticker from the set')
    assert.strictEqual(copyEarnsBoost(copy(fresh(2))), false, 'own files under a copyOf: the free-Boost exploit')
    assert.strictEqual(copyEarnsBoost(copy([...copied(1), ...fresh(1)])), false)
    assert.strictEqual(copyEarnsBoost(copy(copied(1, 'dogs'))), false)
    assert.strictEqual(copyEarnsBoost(copy(fresh(2), { charge: { credits: 1, user: 'u' } })), true, 'into the other type, paid')
    assert.strictEqual(copyEarnsBoost({ ...copy(copied(1)), create: { title: 'x' } }), false, 'no copyOf')

    // Run through: the decision is written down before the first stickers become kept ones.
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const forged = await runCommit({ ...createCommit(2, { copyOf: 'Cats' }), boost: true }, { telegram: tg, ...deps })
    assert.strictEqual(forged.status, 'succeeded', forged.error)
    assert.strictEqual(forged.create.copyBoost, false)
  })

  const restoreDraft = (n) => Array.from({ length: n }, (_, i) => ({
    assetId: `r:o${i}`, file: { restore: { fileUniqueId: `o${i}` }, format: 'static', fileId: `pack-o${i}`, fallbackFileId: `orig-o${i}` }, emojiList: ['🙂']
  }))
  const restoreCommit = (n, create = {}) => ({
    ...newCommit({
      name: '~new:9',
      ownerTelegramId: 7,
      base: [],
      draft: restoreDraft(n),
      packType: 'regular',
      create: { title: 'Old Cats', restoreName: 'Old_Cats_by_bot', restoreFrom: 'old1', ...create }
    }),
    boost: true,
    charge: { credits: 5, user: 'u' }
  })

  await test('restoring a pack: it asks for its old name first, and the deleted document does not make it taken', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const asked = []
    const done = await runCommit(restoreCommit(2), { telegram: tg, ...deps, nameTaken: async (name, opts) => { asked.push([name, opts.except]); return false } })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(done.name, 'Old_Cats_by_bot')
    assert.deepStrictEqual(asked, [['Old_Cats_by_bot', 'old1']])
    assert.strictEqual(done.create.copyBoost, true, 'paid restore starts with Boost')
    assert.strictEqual(done.create.formattedTitle, 'Old Cats :: @bot')
    assert.deepStrictEqual(done.draft.map((item) => item.restoredUid), ['o0', 'o1'], 'the archived rows are remembered')
  })

  await test('restoring a pack: an old name somebody took falls back to a name from the title', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: ['Old_Cats_by_bot'] })
    const { deps } = createDeps(world)
    const done = await runCommit(restoreCommit(1), { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.notStrictEqual(done.name, 'Old_Cats_by_bot')
    assert.match(done.name, /^Old_Cats(_[0-9a-f]{4})?_by_bot$/)
  })

  await test('restoring a pack: a pack Telegram merged files in is still registered, so the old one is not restorable again', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const real = tg.callApi.bind(tg)
    tg.callApi = async (method, params) => {
      const result = await real(method, params)
      // Telegram keeps one sticker per file: the two draft files became one.
      if (method === 'getStickerSet' && result.stickers.length === 2) result.stickers.pop()
      return result
    }
    const { deps, registered } = createDeps(world)
    const done = await runCommit(restoreCommit(2), { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'failed')
    assert.match(done.error, /duplicate/)
    assert.deepStrictEqual(registered, ['Old_Cats_by_bot'])
    assert.strictEqual(done.create.registered, true)
  })

  await test('creating a pack: a merged first batch is not registered unless it is a restore', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const real = tg.callApi.bind(tg)
    tg.callApi = async (method, params) => {
      const result = await real(method, params)
      if (method === 'getStickerSet' && result.stickers.length === 2) result.stickers.pop()
      return result
    }
    const { deps, registered } = createDeps(world)
    const done = await runCommit(createCommit(2), { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'failed')
    assert.deepStrictEqual(registered, [])
  })

  await test('restoring a pack: Boost needs the charge', async () => {
    const { copyEarnsBoost } = require('../pack-ops/execute')
    const base = { boost: true, create: { title: 'x', restoreFrom: 'old1' }, draft: restoreDraft(1) }
    assert.strictEqual(copyEarnsBoost({ ...base, charge: { credits: 5, user: 'u' } }), true)
    assert.strictEqual(copyEarnsBoost(base), false)
    assert.strictEqual(copyEarnsBoost({ ...base, boost: false, charge: { credits: 5, user: 'u' } }), false)
  })

  await test('restoring a pack: a first batch Telegram refuses by file_id is sent once more with the originals', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const real = tg.callApi.bind(tg)
    const sent = []
    tg.callApi = (method, params) => {
      if (method === 'createNewStickerSet') {
        sent.push(params.stickers.map((st) => st.sticker))
        if (params.stickers.some((st) => st.sticker.startsWith('pack-'))) return Promise.reject(telegramError(400, 'Bad Request: wrong file identifier'))
      }
      return real(method, params)
    }
    const { deps } = createDeps(world)
    const done = await runCommit(restoreCommit(2), { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.deepStrictEqual(sent, [['pack-o0', 'pack-o1'], ['orig-o0', 'orig-o1']])
    assert.strictEqual(done.name, 'Old_Cats_by_bot', 'the same name: the refusal was not about it')
  })

  await test('restoring a pack: a refusal that is about the name does not retry with the originals', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: [] })
    const real = tg.callApi.bind(tg)
    let creates = 0
    tg.callApi = (method, params) => {
      if (method === 'createNewStickerSet' && creates++ === 0) return Promise.reject(telegramError(400, 'Bad Request: sticker set name is already occupied'))
      return real(method, params)
    }
    const { deps } = createDeps(world)
    const done = await runCommit(restoreCommit(1), { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(creates, 2)
    assert.strictEqual(tg.created.params.stickers[0].sticker, 'pack-o0', 'next name, still the pack\'s own file_id')
  })

  await test('creating a pack: a link Studio made from the title gets a random tail when taken', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: ['testovyi_pak_by_bot'] })
    const { deps } = createDeps(world)
    const commit = await runCommit(createCommit(1, { title: 'тестовий пак', name: 'testovyi_pak', nameAuto: true }), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.match(commit.name, /^testovyi_pak_[0-9a-f]{4}_by_bot$/)
  })

  await test('creating a pack: a link the user chose is the only one tried', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: ['my_pack_by_bot'] })
    const { deps } = createDeps(world)
    const commit = await runCommit(createCommit(1, { name: 'my_pack' }), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'failed')
    assert.strictEqual(commit.error, 'name_occupied')
  })

  await test('creating a pack: a name taken in Telegram or in our database moves on to the next candidate', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: ['My_Cats_by_bot'] })
    const taken = new Set()
    const { deps } = createDeps(world, { nameTaken: async (name) => taken.has(name) })
    // The second candidate is random; take whatever it is in our database too.
    const commit = createCommit(1)
    const probe = await runCommit(JSON.parse(JSON.stringify(commit)), { telegram: fakeCreatingTelegram({ faultAt: -1 }, { foreign: ['My_Cats_by_bot'] }), ...createDeps({ faultAt: -1 }).deps })
    assert.match(probe.name, /^My_Cats_[0-9a-f]{4}_by_bot$/)
    assert.strictEqual(probe.status, 'succeeded', probe.error)
    taken.add(probe.create.names[1])
    const done = await runCommit(commit, { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.match(done.name, /^My_Cats_[0-9a-f]{4}_by_bot$/)
    assert.notStrictEqual(done.name, probe.create.names[1])
  })

  await test('creating a pack: every candidate taken fails the commit as name_occupied, nothing is made', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps, registered } = createDeps(world, { nameTaken: async () => true })
    const commit = await runCommit(createCommit(2), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'failed')
    assert.strictEqual(commit.error, 'name_occupied')
    assert.strictEqual(tg.created.times, 0)
    assert.deepStrictEqual(registered, [])
  })

  await test('creating a pack: a custom link is used as given (plus the suffix) or the commit fails', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const { deps } = createDeps(world)
    const ok = await runCommit(createCommit(1, { name: 'my_link' }), { telegram: tg, ...deps })
    assert.strictEqual(ok.status, 'succeeded', ok.error)
    assert.strictEqual(ok.name, 'my_link_by_bot')

    const world2 = { faultAt: -1 }
    const busy = await runCommit(createCommit(1, { name: 'my_link' }), { telegram: fakeCreatingTelegram(world2, { foreign: ['my_link_by_bot'] }), ...createDeps(world2).deps })
    assert.strictEqual(busy.status, 'failed')
    assert.strictEqual(busy.error, 'name_occupied')

    const world3 = { faultAt: -1 }
    const bad = await runCommit(createCommit(1, { name: '!!!' }), { telegram: fakeCreatingTelegram(world3), ...createDeps(world3).deps })
    assert.strictEqual(bad.status, 'failed')
    assert.strictEqual(bad.error, 'name_invalid')
  })

  await test('creating a pack: a name Telegram could not register (SHORTNAME_OCCUPY_FAILED) moves on to the next candidate', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const call = tg.callApi.bind(tg)
    const tried = []
    tg.callApi = (method, params) => {
      if (method !== 'createNewStickerSet') return call(method, params)
      tried.push(params.name)
      return tried.length === 1 ? Promise.reject(telegramError(400, 'Bad Request: SHORTNAME_OCCUPY_FAILED')) : call(method, params)
    }
    const { deps } = createDeps(world)
    const commit = await runCommit(createCommit(1), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'succeeded', commit.error)
    assert.strictEqual(tried.length, 2)
    assert.strictEqual(commit.name, tried[1])

    // Every candidate refused so: name_occupied, which asks for another name.
    const world2 = { faultAt: -1 }
    const tg2 = fakeCreatingTelegram(world2)
    const call2 = tg2.callApi.bind(tg2)
    tg2.callApi = (method, params) => (method === 'createNewStickerSet' ? Promise.reject(telegramError(400, 'Bad Request: SHORTNAME_OCCUPY_FAILED')) : call2(method, params))
    const refused = await runCommit(createCommit(1), { telegram: tg2, ...createDeps(world2).deps })
    assert.strictEqual(refused.status, 'failed')
    assert.strictEqual(refused.error, 'name_occupied')
  })

  for (const [description, code] of [
    ['Bad Request: user not found', 'bot_not_started'],
    ['Bad Request: have no access to the user', 'bot_not_started'],
    ['Forbidden: bot was blocked by the user', 'bot_blocked']
  ]) {
    await test(`creating a pack for an owner Telegram won't serve (${description}): ${code}`, async () => {
      const world = { faultAt: -1 }
      const tg = fakeCreatingTelegram(world)
      const call = tg.callApi.bind(tg)
      tg.callApi = (method, params) => (method === 'createNewStickerSet' ? Promise.reject(telegramError(description.startsWith('Forbidden') ? 403 : 400, description)) : call(method, params))
      const { deps, registered } = createDeps(world)
      const commit = await runCommit(createCommit(1), { telegram: tg, ...deps })
      assert.strictEqual(commit.status, 'failed')
      assert.strictEqual(commit.error, code)
      assert.deepStrictEqual(registered, [])
    })
  }

  await test('creating a pack: a refused sticker fails the commit and the pack is not registered', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world)
    const call = tg.callApi.bind(tg)
    tg.callApi = (method, params) => (method === 'createNewStickerSet' ? Promise.reject(telegramError(400, 'Bad Request: STICKER_PNG_DIMENSIONS')) : call(method, params))
    const { deps, registered } = createDeps(world)
    const commit = await runCommit(createCommit(1), { telegram: tg, ...deps })
    assert.strictEqual(commit.status, 'failed')
    assert.match(commit.error, /STICKER_PNG_DIMENSIONS/)
    assert.deepStrictEqual(registered, [])
  })

  for (const fault of ['lost', 'noreply', 'crash-before', 'crash-after']) {
    await test(`a "${fault}" fault on every call of a create publish makes exactly one pack`, async () => {
      const mk = () => createCommit(53)
      const probeWorld = { faultAt: -1 }
      const probe = fakeCreatingTelegram(probeWorld)
      await runCommit(mk(), { telegram: probe, ...createDeps(probeWorld).deps })
      for (let at = 0; at < probe.calls.length; at++) {
        const world = { faultAt: at, fault }
        const tg = fakeCreatingTelegram(world)
        const label = `${fault} at call ${at} (${probe.calls[at]})`
        const { deps, registered } = createDeps(world)
        let commit = mk()
        for (let run = 0; run < 10; run++) {
          try {
            commit = await runCommit(commit, { telegram: tg, ...deps })
          } catch (err) {
            if (!(err instanceof Crash)) throw err
          }
          if (world.crashed) {
            world.crashed = false
            deps.lock.expire(commit.lockName)
            commit = JSON.parse(JSON.stringify(deps.store.saved))
          }
          world.faultAt = -1
          if (['succeeded', 'failed', 'conflict'].includes(commit.status)) break
        }
        assert.strictEqual(commit.status, 'succeeded', `${label}: ${commit.status} ${commit.error}`)
        assert.strictEqual(tg.created.times, 1, label)
        assert.strictEqual(commit.name, 'My_Cats_by_bot', label)
        assert.deepStrictEqual(tg.pack.stickers.map((st) => st.from), fresh(53).map((_, i) => `up${i}`), label)
        assert.ok(registered.length >= 1 && registered.every((n) => n === commit.name), label)
      }
    })
  }

  await test('creating a pack: a set that appeared under the attempted name with another title is not adopted', async () => {
    const world = { faultAt: -1 }
    const tg = fakeCreatingTelegram(world, { foreign: ['My_Cats_by_bot'] })
    const { deps } = createDeps(world)
    const commit = createCommit(1)
    // A run that wrote the attempt down and died before Telegram answered, after someone else took the name.
    Object.assign(commit.create, { names: ['My_Cats_by_bot', 'My_Cats_2_by_bot'], index: 0, formattedTitle: 'My Cats :: @bot', state: 'creating', attempt: 'My_Cats_by_bot' })
    const done = await runCommit(commit, { telegram: tg, ...deps })
    assert.strictEqual(done.status, 'succeeded', done.error)
    assert.strictEqual(done.name, 'My_Cats_2_by_bot')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('pack-ops execute test OK')
})()
