// Unit tests for bot/launch.js withConflictWait: a 409 on getUpdates during a
// deploy overlap is waited out instead of stopping polling.

const assert = require('assert')
const { withConflictWait } = require('../bot/launch')

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

const conflict = () => Object.assign(new Error('409: Conflict: terminated by other getUpdates request'), { code: 409 })
const quiet = { info () {}, warn () {} }

const main = async () => {
  await test('a 409 returns an empty batch after a pause, then polling goes on', async () => {
    let t = 0
    const waits = []
    const steps = [conflict(), conflict(), [{ update_id: 7 }]]
    const fn = withConflictWait(async () => { const s = steps.shift(); if (s instanceof Error) throw s; return s },
      { now: () => t, wait: async (ms) => { waits.push(ms); t += ms }, retryMs: 5000, logger: quiet })
    assert.deepStrictEqual(await fn(), [])
    assert.deepStrictEqual(await fn(), [])
    assert.deepStrictEqual(await fn(), [{ update_id: 7 }])
    assert.deepStrictEqual(waits, [5000, 5000])
  })

  await test('a conflict longer than the limit is a real second instance: it throws', async () => {
    let t = 0
    const fn = withConflictWait(async () => { throw conflict() },
      { now: () => t, wait: async (ms) => { t += ms }, retryMs: 60000, maxMs: 120000, logger: quiet })
    await fn(); await fn(); await fn()
    await assert.rejects(fn(), /409/)
  })

  await test('the limit restarts only after a quiet minute without a 409', async () => {
    let t = 0
    let fail = true
    const fn = withConflictWait(async () => { if (fail) throw conflict(); return [] },
      { now: () => t, wait: async (ms) => { t += ms }, retryMs: 60000, maxMs: 120000, quietMs: 60000, logger: quiet })
    await fn(); await fn()
    fail = false; t += 60000; await fn()
    fail = true; await fn(); await fn(); await fn()
    await assert.rejects(fn(), /409/)
  })

  await test('two live pollers taking turns still hit the limit: one good batch is not the end', async () => {
    let t = 0
    let call = 0
    const fn = withConflictWait(async () => { t += 1000; if (call++ % 2 === 0) throw conflict(); return [] },
      { now: () => t, wait: async (ms) => { t += ms }, retryMs: 5000, maxMs: 120000, quietMs: 60000, logger: quiet })
    let error = null
    for (let i = 0; i < 200 && !error; i++) await fn().catch((e) => { error = e })
    assert.ok(error && error.code === 409, 'a second instance is noticed')
    assert.ok(t <= 130000, `noticed after ${t} ms`)
  })

  await test('other errors and shutdown pass straight through', async () => {
    const other = Object.assign(new Error('401'), { code: 401 })
    await assert.rejects(withConflictWait(async () => { throw other }, { logger: quiet })(), /401/)
    await assert.rejects(withConflictWait(async () => { throw conflict() }, { isShuttingDown: () => true, logger: quiet })(), /409/)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('launch conflict test OK')
}

main()
