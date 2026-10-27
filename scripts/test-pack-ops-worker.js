// Unit tests for pack-ops/worker.js against an in-memory repo and Telegram:
// claiming (incl. a dead process's stale claim), uploading files with resume
// and reuse, the ways an upload can end, and the sync of the bot's sticker
// docs after a publish. The queries themselves (worker-repo.js) are covered by
// scripts/check-studio-worker-live.js.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { createWorker } = require('../pack-ops/worker')

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

const OWNER = 100
const clone = (value) => structuredClone(value)
const telegramError = (code, description) => Object.assign(new Error(description), { code, description })

function world ({ commits = [], assets = [], stickers = [], pack = { _id: 'pack1', placeholderFileUniqueId: null } } = {}) {
  const w = {
    clock: new Date('2026-10-23T12:00:00Z'),
    commits: commits.map(clone),
    assets: new Map(assets.map((a) => [a._id, { ...clone(a), data: a.data }])),
    stickers: stickers.map(clone), // the bot's sticker docs
    pack: clone(pack),
    uploads: [],
    uploadFails: [], // errors to throw on upload N (0-based), in order
    telegramSet: [], // [{ file_unique_id, file_id }]
    locks: [], // names of packs whose lock is held
    published: [],
    sources: {}, // other sets, as this bot's getStickerSet shows them: name -> stickers
    sourceReads: [],
    refunds: [],
    refundedOnUser: new Set(), // commits marked on the user as refunded
    removed: [] // packs marked deleted
  }

  w.repo = {
    async claimForPrepare (now, staleMs) {
      const stale = (c) => c.status === 'preparing' && c.claimedAt < new Date(now.getTime() - staleMs)
      const c = w.commits.find((x) => x.status === 'queued') || w.commits.find(stale)
      if (!c) return null
      c.status = 'preparing'
      c.claimedAt = now
      return clone(c)
    },
    async touchClaim () {},
    async findRunnable (now, staleMs) {
      const c = w.commits.find((x) => !w.locks.includes(x.name) && (x.status === 'pending' ||
        (x.status === 'running' && x.updatedAt < new Date(now.getTime() - staleMs))))
      return c ? clone(c) : null
    },
    async findUnsynced (now, maxAttempts) {
      const c = w.commits.find((x) => x.status === 'succeeded' && !x.synced &&
        !((x.syncAttempts || 0) >= maxAttempts) && (!x.syncAfter || x.syncAfter <= now))
      return c ? clone(c) : null
    },
    async recordSyncFailure (id, { attempts, after, error }) {
      Object.assign(w.commits.find((c) => c._id === id), { syncAttempts: attempts, syncAfter: after, syncError: error })
    },
    async markSynced (id) { w.commits.find((c) => c._id === id).synced = true },
    async loadAsset (id) { return w.assets.has(id) ? { ...clone(w.assets.get(id)), data: w.assets.get(id).data } : null },
    async setAssetFileId (id, fileId, owner, { keepData } = {}) {
      Object.assign(w.assets.get(id), { fileId, fileOwner: owner })
      if (!keepData) delete w.assets.get(id).data
    },
    async findPack () { return clone(w.pack) },
    async writeRemoved (pack) { w.removed.push(pack._id) },
    // As mongoRepo's: the credit is marked on the user, then the commit.
    async refundCharge (id, charge) {
      if (w.refundFails) { w.refundFails--; throw new Error('db down') }
      const paid = !w.refundedOnUser.has(id)
      if (paid) {
        w.refundedOnUser.add(id)
        w.refunds.push({ id, ...charge })
      }
      if (w.crashBeforeMark) { w.crashBeforeMark = false; throw new Error('process died') }
      w.commits.find((x) => x._id === id).charge.refunded = true
      return paid
    },
    async findUnrefunded (now, afterMs) {
      const c = w.commits.find((x) => ['failed', 'conflict'].includes(x.status) && x.charge?.credits > 0 && !x.charge.refunded &&
        !['created', 'done'].includes(x.create?.state) && (!x.updatedAt || x.updatedAt < new Date(now.getTime() - afterMs)))
      return c ? clone(c) : null
    },
    async touch (id, now) { w.commits.find((x) => x._id === id).updatedAt = now },
    async liveStickerUids () { return w.stickers.filter((s) => !s.deleted).map((s) => s.fileUniqueId) },
    async writeSync (packId, { stickers, deletedUids, clearPlaceholder, title }, now) {
      for (const s of stickers) {
        let doc = w.stickers.find((d) => d.fileUniqueId === s.fileUniqueId)
        if (!doc) w.stickers.push(doc = { fileUniqueId: s.fileUniqueId, stickerSet: packId })
        Object.assign(doc, { emojis: s.emojiList.join(' '), emojiList: s.emojiList, fileId: s.fileId, stickerType: 'sticker', deleted: false, deletedAt: null })
        if (s.keywords?.length) doc.keywords = s.keywords
        else if (s.keywords) delete doc.keywords
      }
      for (const doc of w.stickers) if (deletedUids.includes(doc.fileUniqueId)) Object.assign(doc, { deleted: true, deletedAt: now })
      w.pack.updatedAt = now
      if (title) w.pack.title = title
      if (clearPlaceholder) delete w.pack.placeholderFileUniqueId
    }
  }

  w.store = {
    async save (commit) {
      const i = w.commits.findIndex((c) => c._id === commit._id)
      w.commits[i] = clone(commit)
    }
  }

  w.telegram = {
    async callApi (method, params) {
      if (method === 'uploadStickerFile') {
        const n = w.uploads.length
        const fail = w.uploadFails[n]
        if (fail) throw fail
        w.uploads.push(params)
        return { file_id: `fid:${params.sticker.source.toString()}` }
      }
      if (method === 'getStickerSet' && params.name in w.sources) {
        w.sourceReads.push(params.name)
        if (!w.sources[params.name]) throw telegramError(400, 'Bad Request: STICKERSET_INVALID')
        return { stickers: clone(w.sources[params.name]) }
      }
      if (method === 'getStickerSet') return { title: w.telegramTitle, stickers: clone(w.telegramSet) }
      throw new Error(`unexpected ${method}`)
    }
  }

  // The executor is covered by its own tests: here it just marks the commit.
  w.publishAs = 'succeeded'
  w.worker = createWorker({
    repo: w.repo,
    store: w.store,
    telegram: w.telegram,
    now: () => w.clock,
    publish: async (id) => {
      w.published.push(id)
      const c = w.commits.find((x) => x._id === id)
      c.status = w.publishAs
      if (w.publishGone) c.packGone = true
      return clone(c)
    }
  })
  return w
}

const asset = (id, extra = {}) => ({ _id: id, telegramId: OWNER, format: 'static', data: Buffer.from(id), fileId: null, ...extra })
const commit = (extra = {}) => ({
  _id: 'c1',
  name: 'pack_by_bot',
  ownerTelegramId: OWNER,
  status: 'queued',
  base: ['u1', 'u2'],
  draft: [
    { assetId: 'k:u1', fileUniqueId: 'u1', emojiList: ['🙂'] },
    { assetId: 'a:x', file: { studioAssetId: 'x', format: 'static', fileId: null }, emojiList: ['😀'] },
    { assetId: 'a:y', file: { studioAssetId: 'y', format: 'static', fileId: null }, emojiList: ['😎'] },
    { assetId: 'a:z', file: { studioAssetId: 'z', format: 'static', fileId: null }, emojiList: ['🤖'] }
  ],
  ...extra
})
const threeAssets = () => ['x', 'y', 'z'].map((id) => asset(id))

;(async () => {
  console.log('claiming')

  await test('a queued commit is claimed and prepared, then handed to publish', async () => {
    const w = world({ commits: [commit()], assets: threeAssets() })
    assert.strictEqual(await w.worker.step(), true)
    const c = w.commits[0]
    assert.strictEqual(c.claimedAt.getTime(), w.clock.getTime())
    assert.deepStrictEqual(w.published, ['c1'])
    assert.deepStrictEqual(c.draft.filter((i) => i.file).map((i) => i.file.fileId), ['fid:x', 'fid:y', 'fid:z'])
    assert.deepStrictEqual(w.uploads.map((u) => [u.user_id, u.sticker_format]), [[OWNER, 'static'], [OWNER, 'static'], [OWNER, 'static']])
  })

  await test('a stale preparing claim is taken over, a fresh one is left alone', async () => {
    const w = world({ commits: [commit({ status: 'preparing', claimedAt: new Date(w0() - 3 * 60 * 1000) })], assets: threeAssets() })
    assert.strictEqual(await w.worker.step(), true)
    assert.deepStrictEqual(w.published, ['c1'])

    const fresh = world({ commits: [commit({ status: 'preparing', claimedAt: new Date(w0() - 30 * 1000) })], assets: threeAssets() })
    assert.strictEqual(await fresh.worker.step(), false)
    assert.strictEqual(fresh.uploads.length, 0)
  })

  await test('a pending commit and a stale running one are published, a fresh running one is not', async () => {
    const pending = world({ commits: [commit({ status: 'pending' })] })
    assert.strictEqual(await pending.worker.step(), true)
    assert.deepStrictEqual(pending.published, ['c1'])

    const dead = world({ commits: [commit({ status: 'running', updatedAt: new Date(w0() - 3 * 60 * 1000) })] })
    assert.strictEqual(await dead.worker.step(), true)
    assert.deepStrictEqual(dead.published, ['c1'])

    const alive = world({ commits: [commit({ status: 'running', updatedAt: new Date(w0() - 20 * 1000) })] })
    assert.strictEqual(await alive.worker.step(), false)
  })

  await test('nothing to do: no work, no calls', async () => {
    const w = world({ commits: [commit({ status: 'interrupted' }), commit({ _id: 'c2', status: 'failed' })] })
    assert.strictEqual(await w.worker.step(), false)
    assert.strictEqual(w.uploads.length, 0)
  })

  await test('a locked pack does not starve the commits behind it', async () => {
    const stuck = commit({ _id: 'c1', name: 'busy_by_bot', status: 'running', updatedAt: new Date(w0() - 5 * 60 * 1000) })
    const next = commit({ _id: 'c2', name: 'other_by_bot', status: 'pending' })
    const w = world({ commits: [stuck, next] })
    w.locks = ['busy_by_bot']
    assert.strictEqual(await w.worker.step(), true)
    assert.deepStrictEqual(w.published, ['c2'])
    assert.strictEqual(await w.worker.step(), false, 'the locked one is left to its holder')

    w.locks = [] // the holder is gone and the lock expired
    assert.strictEqual(await w.worker.step(), true)
    assert.deepStrictEqual(w.published, ['c2', 'c1'])
  })

  console.log('uploading')

  await test('resume: a crash after one of three uploads does not upload the first again', async () => {
    const w = world({ commits: [commit()], assets: threeAssets() })
    w.uploadFails[1] = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'interrupted')
    assert.strictEqual(w.commits[0].draft[1].file.fileId, 'fid:x')
    assert.strictEqual(w.commits[0].draft[2].file.fileId, null)
    assert.strictEqual(w.uploads.length, 1)

    w.uploadFails = []
    w.commits[0].status = 'queued' // the API's retry
    await w.worker.step()
    assert.strictEqual(w.uploads.length, 3, 'x was not uploaded twice')
    assert.deepStrictEqual(w.uploads.map((u) => u.sticker.source.toString()), ['x', 'y', 'z'])
    assert.deepStrictEqual(w.published, ['c1'])
  })

  await test('resume: the process dies mid-preparing, the stale claim is picked up with the saved file_ids', async () => {
    const half = commit({ status: 'preparing', claimedAt: new Date(w0() - 5 * 60 * 1000) })
    half.draft[1].file.fileId = 'fid:x'
    const w = world({ commits: [half], assets: [asset('x', { fileId: 'fid:x', fileOwner: OWNER }), asset('y'), asset('z')] })
    await w.worker.step()
    assert.deepStrictEqual(w.uploads.map((u) => u.sticker.source.toString()), ['y', 'z'])
  })

  await test('asset reuse: a stored file_id for the same owner is used, another owner\'s is not', async () => {
    const w = world({
      commits: [commit()],
      assets: [asset('x', { fileId: 'fid:old', fileOwner: OWNER }), asset('y', { fileId: 'fid:other', fileOwner: 999 }), asset('z')]
    })
    await w.worker.step()
    assert.deepStrictEqual(w.commits[0].draft.filter((i) => i.file).map((i) => i.file.fileId), ['fid:old', 'fid:y', 'fid:z'])
    assert.deepStrictEqual(w.uploads.map((u) => u.sticker.source.toString()), ['y', 'z'])
    assert.strictEqual(w.assets.get('y').fileId, 'fid:y')
    assert.strictEqual(w.assets.get('y').fileOwner, OWNER)
  })

  await test('the same asset used twice is uploaded once', async () => {
    const c = commit()
    c.draft[3].file.studioAssetId = 'x'
    const w = world({ commits: [c], assets: threeAssets() })
    await w.worker.step()
    assert.deepStrictEqual(w.uploads.map((u) => u.sticker.source.toString()), ['x', 'y'])
    assert.strictEqual(w.commits[0].draft[3].file.fileId, 'fid:x')
  })

  await test('an expired asset fails the commit as asset_missing', async () => {
    const w = world({ commits: [commit()], assets: [asset('x'), asset('z')] })
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'failed')
    assert.strictEqual(w.commits[0].error, 'asset_missing')
    assert.deepStrictEqual(w.published, [])
  })

  await test('a 429 beyond the wait interrupts the commit', async () => {
    const w = world({ commits: [commit()], assets: threeAssets() })
    w.uploadFails[0] = telegramError(429, 'Too Many Requests: retry after 900')
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'interrupted')
    assert.match(w.commits[0].error, /retry after/)
  })

  await test('Telegram refusing a file fails the commit with its text', async () => {
    const w = world({ commits: [commit()], assets: threeAssets() })
    w.uploadFails[1] = telegramError(400, 'Bad Request: STICKER_PNG_DIMENSIONS')
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'failed')
    assert.strictEqual(w.commits[0].error, 'Bad Request: STICKER_PNG_DIMENSIONS')
    assert.deepStrictEqual(w.published, [])
  })

  await test('an owner who never started the bot, or blocked it, fails the commit with a stable code', async () => {
    for (const [error, code] of [
      [telegramError(400, 'Bad Request: user not found'), 'bot_not_started'],
      [telegramError(400, 'Bad Request: have no access to the user'), 'bot_not_started'],
      [telegramError(403, 'Forbidden: bot was blocked by the user'), 'bot_blocked']
    ]) {
      const w = world({ commits: [commit()], assets: threeAssets() })
      w.uploadFails[0] = error
      await w.worker.step()
      assert.strictEqual(w.commits[0].status, 'failed')
      assert.strictEqual(w.commits[0].error, code)
    }
  })

  await test('an uploaded file leaves the database, unless the commit still sends it as the thumbnail', async () => {
    const w = world({ commits: [commit({ settings: { thumbnail: { assetId: 'y' } } })], assets: threeAssets() })
    await w.worker.step()
    assert.strictEqual(w.assets.get('x').data, undefined)
    assert.ok(w.assets.get('y').data, 'the thumbnail keeps its bytes')
    assert.strictEqual(w.assets.get('x').fileId, 'fid:x')
  })

  await test('a file whose bytes are gone is reused by its file_id, or for another owner asked for again', async () => {
    const same = world({ commits: [commit()], assets: ['x', 'y', 'z'].map((id) => ({ ...asset(id, { fileId: `old:${id}`, fileOwner: OWNER }), data: undefined })) })
    await same.worker.step()
    assert.strictEqual(same.uploads.length, 0)
    assert.strictEqual(same.published.length, 1)

    const other = world({ commits: [commit()], assets: ['x', 'y', 'z'].map((id) => ({ ...asset(id, { fileId: `old:${id}`, fileOwner: 999 }), data: undefined })) })
    await other.worker.step()
    assert.strictEqual(other.commits[0].status, 'failed')
    assert.strictEqual(other.commits[0].error, 'asset_missing')
  })

  await test('a lean Binary from Mongo is turned into a Buffer', async () => {
    const w = world({ commits: [commit()], assets: threeAssets() })
    for (const a of w.assets.values()) a.data = { buffer: Buffer.concat([Buffer.from(a._id), Buffer.alloc(16)]), position: a._id.length } // a Binary with spare room
    await w.worker.step()
    assert.ok(w.uploads.every((u) => Buffer.isBuffer(u.sticker.source)))
  })

  console.log('sync')

  const synced = () => {
    const c = commit({
      status: 'succeeded',
      base: ['u1', 'u2', 'u3'],
      mapping: { 'k:u1': 'u1', 'k:u2': 'u2', 'a:x': 'n1', 'a:y': 'n2' },
      draft: [
        { assetId: 'a:x', file: { studioAssetId: 'x', fileId: 'fid:x' }, emojiList: ['😀', '😁'], keywords: ['grin'] },
        { assetId: 'k:u1', fileUniqueId: 'u1', emojiList: ['🙂'] },
        { assetId: 'k:u2', fileUniqueId: 'u2', emojiList: ['🙃'], keywords: [] },
        { assetId: 'a:y', file: { studioAssetId: 'y', fileId: 'fid:y' }, emojiList: ['😎'] }
      ]
    })
    const w = world({
      commits: [c],
      pack: { _id: 'pack1', placeholderFileUniqueId: 'ph' },
      stickers: [
        { stickerSet: 'pack1', fileUniqueId: 'u1', emojis: '🙂', fileId: 'old1', stickerType: 'sticker', deleted: false },
        { stickerSet: 'pack1', fileUniqueId: 'u2', emojis: '🙃', fileId: 'old2', stickerType: 'sticker', keywords: ['gone'], deleted: false },
        { stickerSet: 'pack1', fileUniqueId: 'u3', emojis: '🙄', fileId: 'old3', stickerType: 'sticker', deleted: false },
        { stickerSet: 'pack1', fileUniqueId: 'ph', emojis: '🌟', fileId: 'oldph', stickerType: 'sticker', deleted: false },
        { stickerSet: 'pack1', fileUniqueId: 'old', emojis: '🙄', deleted: true, deletedAt: new Date(0) }
      ]
    })
    w.telegramSet = [
      { file_unique_id: 'n1', file_id: 'F-n1' }, { file_unique_id: 'u1', file_id: 'F-u1' },
      { file_unique_id: 'u2', file_id: 'F-u2' }, { file_unique_id: 'n2', file_id: 'F-n2' }
    ]
    return w
  }

  await test('a succeeded commit syncs: new docs, updated docs, deletions, placeholder', async () => {
    const w = synced()
    assert.strictEqual(await w.worker.step(), true)
    const doc = (uid) => w.stickers.find((s) => s.fileUniqueId === uid)

    assert.deepStrictEqual(
      { ...doc('n1'), stickerSet: undefined },
      { fileUniqueId: 'n1', stickerSet: undefined, emojis: '😀 😁', emojiList: ['😀', '😁'], fileId: 'F-n1', stickerType: 'sticker', deleted: false, deletedAt: null, keywords: ['grin'] }
    )
    assert.strictEqual(doc('n2').fileId, 'F-n2')
    assert.strictEqual('keywords' in doc('n2'), false, 'keywords stay absent unless set')
    assert.strictEqual(doc('u1').fileId, 'F-u1', 'fileId refreshed from getStickerSet')
    assert.deepStrictEqual(doc('u1').emojiList, ['🙂'])
    assert.strictEqual('keywords' in doc('u2'), false, 'empty keywords clear the field')

    assert.strictEqual(doc('u3').deleted, true)
    assert.ok(doc('u3').deletedAt instanceof Date)
    assert.strictEqual(doc('ph').deleted, true)
    assert.strictEqual(doc('old').deletedAt.getTime(), 0, 'already deleted docs are left alone')
    assert.strictEqual('placeholderFileUniqueId' in w.pack, false)
    assert.strictEqual(w.pack.updatedAt.getTime(), w.clock.getTime())
    assert.strictEqual(w.commits[0].synced, true)
    assert.strictEqual(await w.worker.step(), false, 'synced once')
  })

  await test('a published title lands on the pack document as Telegram has it', async () => {
    const w = synced()
    w.commits[0].settings = { title: 'Fresh' }
    w.telegramTitle = 'Fresh :: @bot'
    await w.worker.step()
    assert.strictEqual(w.pack.title, 'Fresh :: @bot')
  })

  await test('a commit without a title leaves the pack title alone', async () => {
    const w = synced()
    w.pack.title = 'Mine'
    w.commits[0].settings = { thumbnail: null }
    w.telegramTitle = 'Other'
    await w.worker.step()
    assert.strictEqual(w.pack.title, 'Mine')
  })

  await test('a placeholder that is still in the pack stays set', async () => {
    const w = synced()
    w.telegramSet.push({ file_unique_id: 'ph', file_id: 'F-ph' })
    await w.worker.step()
    assert.strictEqual(w.pack.placeholderFileUniqueId, 'ph')
    assert.strictEqual(w.stickers.find((s) => s.fileUniqueId === 'ph').deleted, false)
  })

  await test('a publish that succeeds is synced in the same pass', async () => {
    const w = world({ commits: [commit({ mapping: { 'a:x': 'n1', 'a:y': 'n2', 'a:z': 'n3', 'k:u1': 'u1' } })], assets: threeAssets() })
    w.telegramSet = ['n1', 'u1', 'n2', 'n3'].map((uid) => ({ file_unique_id: uid, file_id: `F-${uid}` }))
    await w.worker.step()
    assert.strictEqual(w.commits[0].synced, true)
    assert.strictEqual(w.stickers.length, 4)
  })

  const failingSync = () => {
    const w = synced()
    w.telegram.callApi = async () => { throw new Error('socket hang up') }
    return w
  }

  await test('a failing sync backs off, lets other commits sync, and is given up after 10 tries', async () => {
    const w = failingSync()
    const other = clone(w.commits[0])
    other._id = 'c2'
    w.commits.push(other)

    assert.strictEqual(await w.worker.step(), true)
    assert.strictEqual(w.commits[0].syncAttempts, 1)
    assert.strictEqual(w.commits[0].syncError, 'socket hang up')
    assert.strictEqual(w.commits[0].syncAfter.getTime(), w.clock.getTime() + 10000)

    // c1 isn't due, so c2 is next (and fails on its own schedule).
    assert.strictEqual(await w.worker.step(), true)
    assert.strictEqual(w.commits[1].syncAttempts, 1)
    assert.strictEqual(await w.worker.step(), false, 'nothing is due yet: no spam')

    for (let n = 2; n <= 10; n++) {
      w.clock = new Date(w.clock.getTime() + 11 * 60 * 1000)
      await w.worker.step()
      await w.worker.step()
      assert.strictEqual(w.commits[0].syncAttempts, n)
    }
    assert.strictEqual(w.commits[0].syncAfter.getTime() - w.clock.getTime(), 10 * 60 * 1000, 'backoff is capped at 10 min')
    w.clock = new Date(w.clock.getTime() + 60 * 60 * 1000)
    assert.strictEqual(await w.worker.step(), false, 'given up')
    assert.strictEqual(w.commits[0].synced, undefined)
    assert.strictEqual(w.commits[0].syncError, 'socket hang up')
  })

  await test('a sync that recovers is marked synced', async () => {
    const w = failingSync()
    await w.worker.step()
    w.clock = new Date(w.clock.getTime() + 60 * 1000)
    w.telegram.callApi = async () => ({ stickers: w.telegramSet })
    assert.strictEqual(await w.worker.step(), true)
    assert.strictEqual(w.commits[0].synced, true)
  })

  await test('a failed publish is not synced', async () => {
    const w = world({ commits: [commit({ mapping: {} })], assets: threeAssets() })
    w.publishAs = 'failed'
    await w.worker.step()
    assert.strictEqual(w.commits[0].synced, undefined)
    assert.strictEqual(w.stickers.length, 0)
  })

  console.log('copies')

  const copyItem = (set, uid, emoji = '🙂') => ({ assetId: `c:${uid}`, file: { copy: { set, fileUniqueId: uid }, format: 'static', fileId: null }, emojiList: [emoji] })
  const copyCommit = (extra = {}) => commit({
    base: [],
    draft: [copyItem('cats', 's1'), copyItem('cats', 's2'), copyItem('dogs', 'd1'), { assetId: 'a:x', file: { studioAssetId: 'x', format: 'static', fileId: null }, emojiList: ['😀'] }],
    ...extra
  })
  const sources = () => ({
    cats: [{ file_unique_id: 's1', file_id: 'BOT-s1', is_animated: true }, { file_unique_id: 's2', file_id: 'BOT-s2', is_video: true }],
    dogs: [{ file_unique_id: 'd1', file_id: 'BOT-d1' }]
  })

  await test('copied stickers take this bot\'s file_ids, one read per set, and are not uploaded', async () => {
    const w = world({ commits: [copyCommit()], assets: [asset('x')] })
    w.sources = sources()
    await w.worker.step()
    const draft = w.commits[0].draft
    assert.deepStrictEqual(draft.map((i) => i.file.fileId), ['BOT-s1', 'BOT-s2', 'BOT-d1', 'fid:x'])
    assert.deepStrictEqual(draft.map((i) => i.file.format), ['animated', 'video', 'static', 'static'])
    assert.deepStrictEqual(w.sourceReads, ['cats', 'dogs'])
    assert.deepStrictEqual(w.uploads.map((u) => u.sticker.source.toString()), ['x'])
    assert.deepStrictEqual(w.published, ['c1'])
  })

  await test('a copied sticker that left its set, or a set that is gone, fails the commit as copy_missing', async () => {
    const w = world({ commits: [copyCommit()], assets: [asset('x')] })
    w.sources = { ...sources(), dogs: [] }
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'failed')
    assert.strictEqual(w.commits[0].error, 'copy_missing')

    const gone = world({ commits: [copyCommit()], assets: [asset('x')] })
    gone.sources = { ...sources(), cats: null }
    await gone.worker.step()
    assert.strictEqual(gone.commits[0].error, 'copy_missing')
    assert.deepStrictEqual(gone.published, [])
  })

  await test('a resumed commit keeps the file_ids it already has', async () => {
    const c = copyCommit()
    c.draft[0].file.fileId = 'BOT-s1'
    c.draft[1].file.fileId = 'BOT-s2'
    const w = world({ commits: [c], assets: [asset('x')] })
    w.sources = sources()
    await w.worker.step()
    assert.deepStrictEqual(w.sourceReads, ['dogs'])
  })

  console.log('refunds')

  const paid = (extra = {}) => copyCommit({ create: { title: 'Copy' }, charge: { credits: 1, user: 'u1' }, ...extra })

  await test('a paid copy that fails before the pack exists is refunded once', async () => {
    const w = world({ commits: [paid()], assets: [asset('x')] })
    w.sources = sources()
    w.publishAs = 'failed'
    await w.worker.step()
    assert.deepStrictEqual(w.refunds, [{ id: 'c1', credits: 1, user: 'u1' }])
    assert.strictEqual(w.commits[0].charge.refunded, true)

    await w.worker.step()
    assert.strictEqual(w.refunds.length, 1)
  })

  await test('a paid copy that fails while preparing is refunded', async () => {
    const w = world({ commits: [paid()], assets: [asset('x')] })
    w.sources = { ...sources(), dogs: [] }
    await w.worker.step()
    assert.strictEqual(w.commits[0].status, 'failed')
    assert.strictEqual(w.refunds.length, 1)
  })

  await test('a refund a failure or a dead process left owed is paid later, once', async () => {
    const w = world({ commits: [paid()], assets: [asset('x')] })
    w.sources = sources()
    w.publishAs = 'failed'
    w.refundFails = 1
    await w.worker.step()
    assert.strictEqual(w.refunds.length, 0)
    assert.notStrictEqual(w.commits[0].charge.refunded, true)

    // Not before it has aged, then once.
    await w.worker.step()
    assert.strictEqual(w.refunds.length, 0)
    w.clock = new Date(w.clock.getTime() + 2 * 60 * 1000)
    await w.worker.step()
    assert.strictEqual(w.refunds.length, 1)
    assert.strictEqual(w.commits[0].charge.refunded, true)
    w.clock = new Date(w.clock.getTime() + 2 * 60 * 1000)
    assert.strictEqual(await w.worker.step(), false)
    assert.strictEqual(w.refunds.length, 1)
  })

  await test('a crash between the credit and the commit\'s mark pays nothing twice', async () => {
    const w = world({ commits: [paid()], assets: [asset('x')] })
    w.sources = sources()
    w.publishAs = 'failed'
    w.crashBeforeMark = true
    await w.worker.step()
    assert.strictEqual(w.refunds.length, 1)
    assert.notStrictEqual(w.commits[0].charge.refunded, true)

    w.clock = new Date(w.clock.getTime() + 2 * 60 * 1000)
    await w.worker.step()
    assert.strictEqual(w.refunds.length, 1, 'the user already holds the mark')
    assert.strictEqual(w.commits[0].charge.refunded, true)
  })

  await test('no refund once the pack is made, for an interrupted commit, or for one that cost nothing', async () => {
    const made = world({ commits: [paid({ create: { title: 'Copy', state: 'done' } })], assets: [asset('x')] })
    made.sources = sources()
    made.publishAs = 'failed'
    await made.worker.step()
    assert.strictEqual(made.refunds.length, 0)

    const stopped = world({ commits: [paid()], assets: [asset('x')] })
    stopped.sources = sources()
    stopped.publishAs = 'interrupted'
    await stopped.worker.step()
    assert.strictEqual(stopped.refunds.length, 0)

    const free = world({ commits: [copyCommit({ create: { title: 'Copy' } })], assets: [asset('x')] })
    free.sources = sources()
    free.publishAs = 'failed'
    await free.worker.step()
    assert.strictEqual(free.refunds.length, 0)
  })

  console.log('a pack gone from Telegram')

  await test('a commit that found the pack gone marks it deleted; a plain failure does not', async () => {
    const gone = world({ commits: [commit()], assets: threeAssets() })
    gone.publishAs = 'failed'
    gone.publishGone = true
    await gone.worker.step()
    assert.deepStrictEqual(gone.removed, ['pack1'])

    const failedOnly = world({ commits: [commit()], assets: threeAssets() })
    failedOnly.publishAs = 'failed'
    await failedOnly.worker.step()
    assert.deepStrictEqual(failedOnly.removed, [])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()

// The fake clock, as a number, for building dates relative to it.
function w0 () { return new Date('2026-10-23T12:00:00Z').getTime() }
