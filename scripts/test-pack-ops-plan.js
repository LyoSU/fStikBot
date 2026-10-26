// Unit tests for pack-ops/plan.js. A tiny in-memory pack stands in for
// Telegram with the semantics measured on the test bot (plan 7.1): added
// stickers append, replace keeps the position under a fresh file_unique_id,
// setStickerPositionInSet takes the sticker out and inserts it at `position`.

const assert = require('assert')
const {
  hasConflict,
  planContent,
  mapAfterContent,
  mergeOutside,
  planMoves,
  planMetadata,
  planSettings,
  longestIncreasing
} = require('../pack-ops/plan')

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
    console.log(`        ${error.stack}`)
  }
}

// Deterministic PRNG so a failure reproduces.
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const shuffle = (list, rand) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

let freshId = 0
const fakePack = (ids) => ({
  ids: [...ids],
  delete (id) { this.ids.splice(this.ids.indexOf(id), 1) },
  replace (id) { this.ids[this.ids.indexOf(id)] = `new${++freshId}` },
  add () { this.ids.push(`new${++freshId}`) },
  move (id, position) {
    this.ids.splice(this.ids.indexOf(id), 1)
    this.ids.splice(position, 0, id)
  }
})

// Run a whole publish against the fake pack, as the executor will.
function publish (pack, draft) {
  const before = [...pack.ids]
  const content = planContent(draft, before)
  for (const id of content.deletes) pack.delete(id)
  for (const item of content.replaces) pack.replace(item.fileUniqueId)
  for (let i = 0; i < content.adds.length; i++) pack.add()

  const mapped = mapAfterContent(draft, before, content, [...pack.ids])
  if (mapped.error) throw new Error(mapped.error)

  const target = draft.map((item) => mapped.ok.get(item.assetId))
  const moves = planMoves([...pack.ids], target)
  for (const move of moves) pack.move(move.fileUniqueId, move.position)
  return { content, moves, target }
}

const ids = (n, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
const keep = (id) => ({ assetId: `a-${id}`, fileUniqueId: id, emojiList: ['🙂'] })

test('conflict: same order is no conflict, any change is', () => {
  assert.strictEqual(hasConflict(['a', 'b'], ['a', 'b']), false)
  assert.strictEqual(hasConflict(['a', 'b'], ['b', 'a']), true)
  assert.strictEqual(hasConflict(['a', 'b'], ['a', 'b', 'c']), true)
  assert.strictEqual(hasConflict(['a', 'b'], ['a']), true)
})

test('LIS: finds a longest increasing run', () => {
  const seq = [3, 1, 2, 0, 4, 5]
  const picked = longestIncreasing(seq).map((i) => seq[i])
  assert.deepStrictEqual(picked, [1, 2, 4, 5])
  assert.deepStrictEqual(longestIncreasing([]), [])
})

test('moves: the last of 120 to the front is one call', () => {
  const current = ids(120)
  const target = [current[119], ...current.slice(0, 119)]
  const moves = planMoves(current, target)
  assert.deepStrictEqual(moves, [{ fileUniqueId: 's119', position: 0 }])
})

test('moves: the first to the end is one call, not 119', () => {
  const current = ids(120)
  const target = [...current.slice(1), current[0]]
  const moves = planMoves(current, target)
  assert.strictEqual(moves.length, 1)
  const pack = fakePack(current)
  for (const m of moves) pack.move(m.fileUniqueId, m.position)
  assert.deepStrictEqual(pack.ids, target)
})

test('moves: already in order needs nothing', () => {
  assert.deepStrictEqual(planMoves(ids(50), ids(50)), [])
})

test('moves: 2000 random permutations reach the target in n − LIS calls', () => {
  const rand = rng(42)
  for (let round = 0; round < 2000; round++) {
    const n = 1 + Math.floor(rand() * 120)
    const current = ids(n)
    const target = shuffle(current, rand)
    const moves = planMoves(current, target)

    const pack = fakePack(current)
    for (const m of moves) pack.move(m.fileUniqueId, m.position)
    assert.deepStrictEqual(pack.ids, target, `round ${round}`)

    const targetIndex = new Map(target.map((id, i) => [id, i]))
    const lis = longestIncreasing(current.map((id) => targetIndex.get(id))).length
    assert.strictEqual(moves.length, n - lis, `round ${round}: not minimal`)
  }
})

test('moves: refuses lists that hold different stickers', () => {
  assert.throws(() => planMoves(['a', 'b'], ['a', 'c']))
  assert.throws(() => planMoves(['a', 'b'], ['a']))
})

test('content: keep, replace, add and delete in one draft', () => {
  const remote = ['x', 'y', 'z']
  const draft = [
    { assetId: 'new1', file: {}, emojiList: ['😀'] },
    { assetId: 'a-z', fileUniqueId: 'z', emojiList: ['🙂'] },
    { assetId: 'a-x', fileUniqueId: 'x', file: {}, emojiList: ['🙂'] }
  ]
  const content = planContent(draft, remote)
  assert.deepStrictEqual(content.deletes, ['y'])
  assert.deepStrictEqual(content.replaces.map((i) => i.assetId), ['a-x'])
  assert.deepStrictEqual(content.adds.map((i) => i.assetId), ['new1'])
})

test('content: refuses a draft pointing at a sticker not in the pack, or twice at one', () => {
  assert.throws(() => planContent([keep('gone')], ['x']))
  assert.throws(() => planContent([keep('x'), { ...keep('x'), assetId: 'dup' }], ['x']))
})

test('full publish: replace keeps its place, adds append, order fixed after', () => {
  const pack = fakePack(['x', 'y', 'z'])
  const draft = [
    { assetId: 'new1', file: {}, emojiList: ['😀'] },
    keep('z'),
    { assetId: 'a-x', fileUniqueId: 'x', file: {}, emojiList: ['🙂'] }
  ]
  const { target } = publish(pack, draft)
  assert.deepStrictEqual(pack.ids, target)
  assert.strictEqual(pack.ids[1], 'z')
  assert.ok(!pack.ids.includes('x') && !pack.ids.includes('y'))
})

test('full publish: deleting every sticker leaves an empty pack', () => {
  const pack = fakePack(['x', 'y'])
  publish(pack, [])
  assert.deepStrictEqual(pack.ids, [])
})

test('full publish: 500 random drafts over packs of up to 120', () => {
  const rand = rng(7)
  for (let round = 0; round < 500; round++) {
    const remote = ids(Math.floor(rand() * 121), `r${round}-`)
    const draft = []
    for (const id of shuffle(remote, rand)) {
      const roll = rand()
      if (roll < 0.15) continue // deleted
      if (roll < 0.3) draft.push({ assetId: `a-${id}`, fileUniqueId: id, file: {}, emojiList: ['🙂'] })
      else draft.push(keep(id))
    }
    const adds = Math.floor(rand() * Math.max(1, 120 - draft.length))
    for (let i = 0; i < adds; i++) {
      draft.splice(Math.floor(rand() * (draft.length + 1)), 0, { assetId: `n${round}-${i}`, file: {}, emojiList: ['😀'] })
    }

    const pack = fakePack(remote)
    const { target } = publish(pack, draft)
    assert.deepStrictEqual(pack.ids, target, `round ${round}`)
    assert.strictEqual(pack.ids.length, draft.length, `round ${round}`)
  }
})

test('mapping: refuses when someone added a sticker during the publish', () => {
  const pack = fakePack(['x', 'y'])
  const draft = [keep('x'), keep('y'), { assetId: 'n', file: {}, emojiList: ['😀'] }]
  const before = [...pack.ids]
  const content = planContent(draft, before)
  pack.add() // ours
  pack.add() // someone else's, outside the lock
  const mapped = mapAfterContent(draft, before, content, [...pack.ids])
  assert.ok(mapped.error, 'must not guess')
})

test('mapping: kept stickers are found by id wherever they are', () => {
  // A replace with a file already in the pack moves that sticker into place.
  const draft = [keep('x'), keep('y')]
  const content = planContent(draft, ['x', 'y'])
  const mapped = mapAfterContent(draft, ['x', 'y'], content, ['y', 'x'])
  assert.deepStrictEqual([...mapped.ok], [['a-x', 'x'], ['a-y', 'y']])
})

test('mapping: refuses when a kept sticker is gone', () => {
  const draft = [keep('x'), { assetId: 'n', file: {}, emojiList: ['😀'] }]
  const content = planContent(draft, ['x', 'y'])
  // y was deleted, the add landed, and x vanished while z appeared.
  const mapped = mapAfterContent(draft, ['x', 'y'], content, ['z', 'new'])
  assert.match(mapped.error, /x is no longer in the pack/)
})

test('mapping: a deleted sticker\'s file added again comes back under its old id', () => {
  // Telegram hands back the very sticker a file was made from: delete y, add
  // y's file, and y is the new sticker.
  const draft = [keep('x'), { assetId: 'n', file: {}, emojiList: ['😀'] }]
  const content = planContent(draft, ['x', 'y'])
  assert.deepStrictEqual(content.deletes, ['y'])
  const mapped = mapAfterContent(draft, ['x', 'y'], content, ['x', 'y'])
  assert.deepStrictEqual([...mapped.ok], [['a-x', 'x'], ['n', 'y']])
})

test('mapping: new stickers in the order the content phase made them', () => {
  const draft = [
    { assetId: 'n1', file: {}, emojiList: ['😀'] },
    { assetId: 'r-y', fileUniqueId: 'y', file: {}, emojiList: ['😀'] },
    keep('x'),
    { assetId: 'n2', file: {}, emojiList: ['😀'] }
  ]
  const content = planContent(draft, ['x', 'y'])
  // y replaced in place by p, then n1 and n2 appended in draft order.
  const mapped = mapAfterContent(draft, ['x', 'y'], content, ['x', 'p', 'q', 'r'])
  assert.deepStrictEqual(Object.fromEntries(mapped.ok), { 'r-y': 'p', 'a-x': 'x', n1: 'q', n2: 'r' })
})

// mergeOutside: base → fresh changed outside, base → draft in the draft.
const merge = (base, fresh, draft, known = new Map()) => mergeOutside(base, fresh, draft, known)
const order = (result) => result.draft.map((item) => item.fileUniqueId || item.assetId)

// What our database holds for every base sticker, as the API sends it.
const knownAll = (base) => new Map(base.map((uid) => [uid, { emojiList: ['🙂'] }]))

test('merge: deleted outside and kept untouched stays deleted; deleted on both sides is nothing to do', () => {
  const result = merge(['a', 'b', 'c'], ['a', 'c'], [keep('a'), keep('b')], knownAll(['a', 'b', 'c']))
  assert.deepStrictEqual(order(result), ['a'])
  // c, dropped from the draft, is what planContent deletes from fresh.
  assert.deepStrictEqual(planContent(result.draft, ['a', 'c']).deletes, ['c'])
  assert.deepStrictEqual(planContent(merge(['a', 'b'], ['a'], [keep('a')]).draft, ['a']).deletes, [])
  // Nothing known of its emoji: the draft's can't be told from an edit.
  assert.ok(merge(['a', 'b'], ['a'], [keep('a'), keep('b')]).conflicts)
})

test('merge: deleted outside but replaced, relabelled or given keywords in the draft is a conflict', () => {
  const known = new Map([['b', { emojiList: ['🙂'] }]])
  assert.deepStrictEqual(merge(['a', 'b'], ['a'], [keep('a'), { ...keep('b'), file: {} }], known).conflicts, [{ fileUniqueId: 'b', reason: 'replaced in the draft, deleted outside' }])
  assert.deepStrictEqual(merge(['a', 'b'], ['a'], [keep('a'), { ...keep('b'), emojiList: ['😡'] }], known).conflicts, [{ fileUniqueId: 'b', reason: 'edited in the draft, deleted outside' }])
  assert.deepStrictEqual(merge(['a', 'b'], ['a'], [keep('a'), { ...keep('b'), keywords: ['x'] }], known).conflicts, [{ fileUniqueId: 'b', reason: 'edited in the draft, deleted outside' }])
  assert.ok(!merge(['a', 'b'], ['a'], [keep('a'), keep('b')], known).conflicts)
})

test('merge: added outside lands before the sticker that follows it in fresh, else after the pack\'s last', () => {
  const n = { assetId: 'n', file: {}, emojiList: ['😀'] }
  assert.deepStrictEqual(order(merge(['a', 'b'], ['a', 'b', 'x'], [keep('a'), keep('b'), n])), ['a', 'b', 'x', 'n'])
  assert.deepStrictEqual(order(merge(['a', 'b'], ['x', 'a', 'b'], [keep('a'), keep('b')])), ['x', 'a', 'b'])
  assert.deepStrictEqual(order(merge(['a', 'b', 'c'], ['a', 'x', 'b', 'c'], [keep('a'), keep('c')])), ['a', 'x', 'c'], 'its follower deleted in the draft: the next one')
  assert.deepStrictEqual(order(merge(['a', 'b'], ['a', 'b', 'x', 'y'], [keep('a'), keep('b')])), ['a', 'b', 'x', 'y'])
  const added = merge(['a'], ['a', 'x'], [keep('a')]).draft[1]
  assert.deepStrictEqual(added, { assetId: 'o:x', fileUniqueId: 'x' })
})

test('merge: the order of the kept stickers is the side that moved them', () => {
  // Moved in the draft only.
  assert.deepStrictEqual(order(merge(['a', 'b', 'c'], ['a', 'b', 'c', 'x'], [keep('c'), keep('a'), keep('b')])), ['c', 'a', 'b', 'x'])
  // Moved outside only: the draft's new sticker keeps its place among them.
  const n = { assetId: 'n', file: {}, emojiList: ['😀'] }
  assert.deepStrictEqual(order(merge(['a', 'b', 'c'], ['c', 'a', 'b'], [keep('a'), n, keep('b'), keep('c')])), ['c', n.assetId, 'a', 'b'])
  // Moved alike on both sides.
  assert.ok(!merge(['a', 'b'], ['b', 'a'], [keep('b'), keep('a')]).conflicts)
  // Moved differently.
  assert.deepStrictEqual(merge(['a', 'b', 'c'], ['c', 'a', 'b'], [keep('b'), keep('a'), keep('c')]).conflicts, [{ reason: 'reordered in the draft and outside' }])
})

test('merge: 2000 random merges keep exactly the draft\'s new stickers and fresh\'s survivors', () => {
  let seed = 11
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let round = 0; round < 2000; round++) {
    const base = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => `b${i}`)
    const draft = base.filter(() => rand() > 0.3).map((uid) => keep(uid))
    if (rand() < 0.5) draft.splice(Math.floor(rand() * (draft.length + 1)), 0, { assetId: 'n', file: {}, emojiList: ['😀'] })
    const fresh = base.filter(() => rand() > 0.3)
    if (rand() < 0.5) fresh.splice(Math.floor(rand() * (fresh.length + 1)), 0, 'x')
    const result = merge(base, fresh, draft, knownAll(base))
    assert.ok(!result.conflicts, 'untouched stickers never conflict')
    const ids = order(result)
    const expected = new Set([...draft.filter((item) => !item.fileUniqueId || fresh.includes(item.fileUniqueId)).map((item) => item.fileUniqueId || item.assetId), ...fresh.filter((uid) => !base.includes(uid))])
    assert.deepStrictEqual(new Set(ids), expected, `round ${round}`)
    assert.strictEqual(ids.length, expected.size)
    // Carried out on fresh, it plans without complaint.
    planContent(result.draft, fresh)
  }
})

test('metadata: only changed emoji, keywords only when the draft sets them', () => {
  const known = new Map([
    ['a', { emojiList: ['🙂'], keywords: ['cat'] }],
    ['b', { emojiList: ['🙂'] }], // keywords never set by us
    ['c', { emojiList: ['🙂'], keywords: [] }]
  ])
  const draft = [
    { assetId: '1', fileUniqueId: 'a', emojiList: ['🙂'], keywords: ['cat'] }, // unchanged
    { assetId: '2', fileUniqueId: 'b', emojiList: ['😀', '🙂'] }, // emoji changed, keywords left alone
    { assetId: '3', fileUniqueId: 'c', emojiList: ['🙂'], keywords: ['dog'] }, // keywords changed
    { assetId: '4', fileUniqueId: 'b', file: {}, emojiList: ['😡'] } // replaced: carries its own
  ]
  assert.deepStrictEqual(planMetadata(draft, known), [
    { fileUniqueId: 'b', emojiList: ['😀', '🙂'] },
    { fileUniqueId: 'c', keywords: ['dog'] }
  ])
})

test('metadata: keywords set over an unknown value are written', () => {
  const known = new Map([['b', { emojiList: ['🙂'] }]])
  const draft = [{ assetId: '1', fileUniqueId: 'b', emojiList: ['🙂'], keywords: [] }]
  assert.deepStrictEqual(planMetadata(draft, known), [{ fileUniqueId: 'b', keywords: [] }])
})

test('settings: a step per part that is present, a null thumbnail drops it', () => {
  assert.deepStrictEqual(planSettings({}), [])
  assert.deepStrictEqual(planSettings({ title: 'T' }), [{ kind: 'title', title: 'T' }])
  assert.deepStrictEqual(planSettings({ title: 'T', thumbnail: { assetId: 'a' } }), [{ kind: 'title', title: 'T' }, { kind: 'thumbnail', assetId: 'a' }])
  assert.deepStrictEqual(planSettings({ thumbnail: { fromSticker: 'u' } }), [{ kind: 'thumbnail', fromSticker: 'u' }])
  assert.deepStrictEqual(planSettings({ thumbnail: null }), [{ kind: 'thumbnail' }])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
console.log('pack-ops plan test OK')
