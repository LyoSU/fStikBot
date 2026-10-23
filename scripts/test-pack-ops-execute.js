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
// with it moves the existing sticker into place.
function fakeTelegram (initial, world) {
  let fresh = 0
  const pack = { stickers: initial.map((uid) => ({ uid, emoji: ['🙂'], keywords: [] })) }
  const byFileId = (fileId) => pack.stickers.find((s) => `fid:${s.uid}` === fileId)
  const calls = []

  const apply = {
    getStickerSet: () => ({ stickers: pack.stickers.map((s) => ({ file_unique_id: s.uid, file_id: `fid:${s.uid}`, format: 'static' })) }),
    deleteStickerFromSet: ({ sticker }) => {
      const s = byFileId(sticker)
      if (!s) throw telegramError(400, 'Bad Request: STICKER_INVALID')
      pack.stickers.splice(pack.stickers.indexOf(s), 1)
      return true
    },
    replaceStickerInSet: ({ old_sticker: old, sticker }) => {
      const s = byFileId(old)
      if (!s) throw telegramError(400, 'Bad Request: STICKER_INVALID')
      const same = pack.stickers.find((x) => x.from === sticker.sticker)
      if (same) {
        pack.stickers.splice(pack.stickers.indexOf(same), 1)
        pack.stickers[pack.stickers.indexOf(s)] = same
        return true
      }
      pack.stickers[pack.stickers.indexOf(s)] = { uid: `new${++fresh}`, from: sticker.sticker, emoji: sticker.emoji_list, keywords: sticker.keywords || [] }
      return true
    },
    addStickerToSet: ({ sticker }) => {
      if (pack.stickers.some((x) => x.from === sticker.sticker)) return true
      pack.stickers.push({ uid: `new${++fresh}`, from: sticker.sticker, emoji: sticker.emoji_list, keywords: sticker.keywords || [] })
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
    async callApi (method, params) {
      const index = calls.length
      calls.push(method)
      const fault = world.faultAt === index ? world.fault : null
      if (fault === 'lost') throw networkError()
      if (fault === 'crash-before') { world.crashed = true; throw new Crash('crash') }
      const result = JSON.parse(JSON.stringify(apply[method](params)))
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
async function runToEnd (initialCommit, tg, store, lock, world) {
  let commit = initialCommit
  for (let run = 0; run < 10; run++) {
    try {
      commit = await runCommit(commit, { telegram: tg, store, lock })
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

  await test('a pack changed since the draft opened is refused untouched', async () => {
    const world = { faultAt: -1 }
    const tg = fakeTelegram(['x', 'y', 'z'], world)
    const commit = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base: ['x', 'y'], draft: [] }), { telegram: tg, store: fakeStore(world), lock: fakeLock(world) })
    assert.strictEqual(commit.status, 'conflict')
    assert.deepStrictEqual(tg.pack.stickers.map((s) => s.uid), ['x', 'y', 'z'])
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

  // Two draft items with the same uploaded file: Telegram keeps one.
  for (const kind of ['add', 'replace']) {
    for (const fault of [null, 'lost', 'noreply', 'crash-before', 'crash-after']) {
      await test(`a duplicate file in a ${kind} stops the publish safely${fault ? ` (with a "${fault}" fault on it)` : ''}`, async () => {
        const base = ['x', 'y', 'z']
        const draft = kind === 'add'
          ? [
              { assetId: 'a-x', fileUniqueId: 'x', emojiList: ['🙂'] },
              { assetId: 'first', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'second', file: { fileId: 'upload:same' }, emojiList: ['😀'] }
            ]
          : [
              { assetId: 'a-x', fileUniqueId: 'x', file: { fileId: 'upload:same' }, emojiList: ['😀'] },
              { assetId: 'a-y', fileUniqueId: 'y', file: { fileId: 'upload:same' }, emojiList: ['😀'] }
            ]
        // Where is the call carrying the duplicate? Probe a clean run.
        const probeWorld = { faultAt: -1 }
        const probe = fakeTelegram(base, probeWorld)
        const plain = await runCommit(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), { telegram: probe, store: fakeStore(probeWorld), lock: fakeLock(probeWorld) })
        assert.strictEqual(plain.status, 'failed')
        assert.match(plain.error, /duplicate/)
        // The duplicate is the second add / the second replace.
        const method = kind === 'add' ? 'addStickerToSet' : 'replaceStickerInSet'
        const target = probe.calls.map((m, i) => [m, i]).filter(([m]) => m === method)[1][1]

        const world = { faultAt: fault ? target : -1, fault }
        const tg = fakeTelegram(base, world)
        const store = fakeStore(world)
        const lock = fakeLock(world)
        const commit = await runToEnd(newCommit({ name: 'p', ownerTelegramId: 1, base, draft }), tg, store, lock, world)
        assert.strictEqual(commit.status, 'failed', `${commit.status} ${commit.error}`)
        assert.match(commit.error, /duplicate/)
        // Nothing lost that the draft kept, nothing doubled: the file is there
        // once (y and z, left out of the draft, were deleted before it).
        if (kind === 'add') assert.ok(tg.pack.stickers.some((st) => st.uid === 'x'))
        else assert.strictEqual(tg.pack.stickers.length, 1)
        assert.strictEqual(tg.pack.stickers.filter((st) => st.from === 'upload:same').length, 1)
      })
    }
  }

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

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('pack-ops execute test OK')
})()
