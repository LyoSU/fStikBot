// Per-user sticker queue (utils/user-queue.js) and album collection (utils/media-group.js).
process.env.MEDIA_GROUP_QUIET_MS = '50'

const assert = require('assert')
const userQueue = require('../utils/user-queue')
const mediaGroup = require('../utils/media-group')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}

;(async () => {
  await test('one at a time, in arrival order', async () => {
    const log = []
    let running = 0
    let maxRunning = 0
    const task = (id, ms) => async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await sleep(ms)
      log.push(id)
      running--
    }
    const first = userQueue.enqueue(1, task('a', 30))
    const second = userQueue.enqueue(1, task('b', 5))
    userQueue.enqueue(1, task('c', 1))
    assert.strictEqual(first.started, true)
    assert.strictEqual(second.started, false)
    await sleep(100)
    assert.deepStrictEqual(log, ['a', 'b', 'c'])
    assert.strictEqual(maxRunning, 1)
  })

  await test('boosted tasks run side by side', async () => {
    let running = 0
    let maxRunning = 0
    const task = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await sleep(20)
      running--
    }
    for (let i = 0; i < 5; i++) userQueue.enqueue(2, task, { concurrency: 3 })
    await sleep(80)
    assert.strictEqual(maxRunning, 3)
  })

  await test('different users do not wait for each other', async () => {
    const log = []
    userQueue.enqueue(3, async () => { await sleep(40); log.push('slow') })
    userQueue.enqueue(4, async () => { log.push('fast') })
    await sleep(10)
    assert.deepStrictEqual(log, ['fast'])
    await sleep(50)
  })

  await test('a throwing task does not stall the queue', async () => {
    const log = []
    const originalError = console.error
    userQueue.enqueue(5, async () => { throw new Error('boom') })
    userQueue.enqueue(5, async () => { log.push('after') })
    await sleep(20)
    console.error = originalError
    assert.deepStrictEqual(log, ['after'])
  })

  await test('the pending cap refuses, then frees up', async () => {
    const block = () => sleep(30)
    for (let i = 0; i < userQueue.MAX_PENDING; i++) assert.ok(userQueue.enqueue(6, block))
    assert.strictEqual(userQueue.enqueue(6, block), null)
    await sleep(30 * userQueue.MAX_PENDING + 50)
    assert.ok(userQueue.enqueue(6, block))
    await sleep(40)
  })

  await test('queues are dropped once empty', async () => {
    await sleep(20)
    assert.strictEqual(userQueue._size(), 0)
  })

  await test('album: first message gets every item after a quiet period', async () => {
    const a = mediaGroup.collect('chat:1', 1)
    const b = mediaGroup.collect('chat:1', 2)
    await sleep(20)
    const c = mediaGroup.collect('chat:1', 3)
    assert.strictEqual(a.first, true)
    assert.strictEqual(b.first, false)
    assert.strictEqual(c.first, false)
    assert.deepStrictEqual(await a.items, [1, 2, 3])
  })

  await test('album: a new album with the same id after completion starts fresh', async () => {
    const again = mediaGroup.collect('chat:1', 4)
    assert.strictEqual(again.first, true)
    assert.deepStrictEqual(await again.items, [4])
  })

  if (failed) process.exit(1)
  console.log('user-queue test OK')
})()
