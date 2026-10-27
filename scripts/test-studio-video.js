// Unit tests for utils/studio-video.js against an in-memory repo and a fake
// convert queue: a Studio video goes to the converter as a chat video would
// (frame, crop, length, priority), the WebM comes back into the row, and every
// way it can fail ends in a state Studio can show.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { createVideoConverter, CLAIM_STALE_MS, HEARTBEAT_MS, MAX_ATTEMPTS, MAX_IN_FLIGHT, QUEUE_WAIT_MS } = require('../utils/studio-video')
const { runQueueJob } = require('../utils/queue-job')
const { convertDelay, maxVideoDuration } = require('../utils/video-convert-rules')

let passed = 0
let failed = 0
let finished = false

// A run that never settles empties the event loop (every timer here is
// unref'd): the process would end quietly, as if every test had passed.
process.on('exit', (code) => {
  if (finished || code) return
  console.log('  FAIL  exited before the tests finished: a conversion never settled')
  process.exitCode = 1
})

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

const NOW = new Date('2026-10-26T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms)

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 7, 7, 7])
const DONE = { result: { content: WEBM.toString('base64'), metadata: { streams: [{ codec_type: 'video', width: 512, height: 288 }] } } }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The converter's timers are unref'd: with nothing else pending, a test that
// waits on its deadline needs the process kept up.
async function awake (fn) {
  const keep = setInterval(() => {}, 1000)
  try {
    return await fn()
  } finally {
    clearInterval(keep)
  }
}

function world ({ videos = [], users = [{ _id: 'u1', telegram_id: 5, locale: 'uk' }], videoPacks = 0, outcome = DONE, waiting = 0, disabled = false, heartbeatMs, runDeadlineMs, queueLookMs, redisJobs = {}, jobState, setJob } = {}) {
  const w = { videos, jobs: [], followed: [], renewals: 0, listeners: {} }
  // Every claim and renewal is a moment later than the one before.
  let clock = NOW.getTime()
  const now = () => new Date(++clock)

  w.repo = {
    claim: async (now, staleBefore, queuedAfter) => {
      const video = videos
        .filter((v) => (v.status === 'queued' && v.createdAt >= queuedAfter) || (v.status === 'converting' && v.claimedAt < staleBefore))
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!video) return null
      Object.assign(video, { status: 'converting', claimedAt: now, attempts: (video.attempts || 0) + 1 })
      return { ...video }
    },
    expire: async (queuedAfter, at) => {
      const old = videos.filter((v) => v.status === 'queued' && v.createdAt < queuedAfter)
      for (const row of old) {
        Object.assign(row, { status: 'failed', error: 'timeout', updatedAt: at })
        delete row.source
        delete row.sourceUrl
      }
      return old.length
    },
    findUser: async (telegramId) => users.find((u) => u.telegram_id === telegramId) || null,
    countVideoPacks: async () => videoPacks,
    renew: async (video, at) => {
      const row = videos.find((v) => v._id === video._id)
      if (row.status !== 'converting' || row.claimedAt.getTime() !== video.claimedAt.getTime()) return false
      w.renewals++
      row.claimedAt = at
      return true
    },
    setJob: async (video, jobId) => {
      if (setJob) await setJob()
      const row = videos.find((v) => v._id === video._id)
      if (row.claimedAt.getTime() !== video.claimedAt.getTime()) return
      row.jobId = jobId
      row.waiting = true
      delete row.startedAt
    },
    started: async (video, at) => {
      const row = videos.find((v) => v._id === video._id)
      if (row.status !== 'converting' || row.claimedAt.getTime() !== video.claimedAt.getTime()) return
      row.startedAt = at
      delete row.waiting
    },
    settle: async (video, set) => {
      const row = videos.find((v) => v._id === video._id)
      if (row.status !== 'converting' || row.claimedAt.getTime() !== video.claimedAt.getTime()) return
      Object.assign(row, set)
      delete row.source
      delete row.sourceUrl
    }
  }
  // Jobs Redis still has, by id: what a restarted process finds again.
  w.queue = {
    disabled,
    getJobCounts: async () => ({ waiting }),
    getJob: async (id) => redisJobs[id] || null,
    on: (event, fn) => { w.listeners[event] = fn }
  }
  w.runJob = async (queue, data, options) => {
    const job = { id: `job${w.jobs.length + 1}`, opts: { priority: options.priority }, ...(jobState ? { getState: async () => jobState() } : {}) }
    w.jobs.push({ data, options })
    if (options.onQueued) await options.onQueued(job)
    return typeof outcome === 'function' ? outcome(data) : outcome
  }
  w.followJob = async (queue, job) => {
    w.followed.push(job.id)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  w.converter = createVideoConverter({ repo: w.repo, queue: w.queue, runJob: w.runJob, followJob: w.followJob, now, heartbeatMs, runDeadlineMs, queueLookMs })
  w.run = async () => {
    await w.converter.tick()
    await w.converter.settled()
  }
  return w
}

const queued = (patch = {}) => ({
  _id: 'v1',
  telegramId: 5,
  packType: 'regular',
  boost: false,
  frameType: 'rounded',
  status: 'queued',
  sourceUrl: 'https://api.fstik.app/studio/video/source?id=v1&key=k',
  source: Buffer.from('mp4'),
  createdAt: ago(1000),
  ...patch
})

;(async () => {
  console.log('studio-video')

  await test('the chat\'s rules: Boost first and longer, the rest by video packs and language', () => {
    // The ordering itself is tested in test-convert-rules.js.
    assert.strictEqual(maxVideoDuration(true), 35)
    assert.strictEqual(maxVideoDuration(false), 4)
  })

  await test('a sticker video goes to the converter like a chat video and comes back as WebM', async () => {
    const w = world({ videos: [queued()], videoPacks: 6 })
    await w.run()

    assert.strictEqual(w.jobs.length, 1)
    const { data, options } = w.jobs[0]
    assert.strictEqual(data.fileUrl, 'https://api.fstik.app/studio/video/source?id=v1&key=k')
    assert.strictEqual(data.isEmoji, false)
    assert.strictEqual(data.forceCrop, false)
    assert.strictEqual(data.frameType, 'rounded')
    assert.strictEqual(data.maxDuration, 4)
    // No `input`: the chat's completed/failed handlers must skip this job.
    assert.strictEqual('input' in data, false)
    // A deadline: added now, with the tier's head start given away.
    const deadline = options.priority - Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000)
    assert.ok(Math.abs(deadline - convertDelay({ videoPacks: 6, locale: 'uk' })) <= 1, `delay ${deadline}`)
    assert.strictEqual(options.keepSeconds, 600)
    assert.strictEqual(data.maxAgeMs, 10 * 60 * 1000)
    // The job's id is on the row, for whoever takes the video over.
    assert.strictEqual(w.videos[0].jobId, 'job1')

    const v = w.videos[0]
    assert.strictEqual(v.status, 'done')
    assert.deepStrictEqual(v.result, WEBM)
    assert.strictEqual(v.size, WEBM.length)
    assert.strictEqual(v.width, 512)
    assert.strictEqual(v.height, 288)
    // The file and its link are of no use any more.
    assert.strictEqual(v.source, undefined)
    assert.strictEqual(v.sourceUrl, undefined)
  })

  await test('an emoji is cropped square, and a boosted pack keeps 35 s at Boost priority', async () => {
    const w = world({ videos: [queued({ packType: 'custom_emoji', boost: true, frameType: undefined })] })
    await w.run()

    const { data, options } = w.jobs[0]
    assert.strictEqual(data.isEmoji, true)
    assert.strictEqual(data.forceCrop, true)
    assert.strictEqual(data.frameType, 'square')
    assert.strictEqual(data.maxDuration, 35)
    assert.ok(Math.abs(options.priority - Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000)) <= 1, 'Boost gives no head start away')
  })

  await test('a failed, lost or timed-out conversion fails with its reason', async () => {
    for (const [error, expected] of [['failed', 'convert'], ['timeout', 'timeout'], ['enqueue', 'convert'], ['disabled', 'unavailable']]) {
      const w = world({ videos: [queued()], outcome: { error } })
      await w.run()
      assert.strictEqual(w.videos[0].status, 'failed')
      assert.strictEqual(w.videos[0].error, expected)
      assert.strictEqual(w.videos[0].source, undefined)
    }
  })

  await test('a throw on the way fails the video instead of leaving it converting', async () => {
    const w = world({ videos: [queued()], outcome: () => { throw new Error('redis down') } })
    await w.run()
    assert.strictEqual(w.videos[0].status, 'failed')
    assert.strictEqual(w.videos[0].error, 'convert')
  })

  await test('a full queue turns a low-priority video away, as the chat does', async () => {
    const w = world({ videos: [queued()], users: [{ _id: 'u1', telegram_id: 5, locale: 'ru' }], videoPacks: 60, waiting: 250 })
    await w.run()
    assert.strictEqual(w.jobs.length, 0)
    assert.strictEqual(w.videos[0].error, 'busy')

    const boosted = world({ videos: [queued({ boost: true })], waiting: 250 })
    await boosted.run()
    assert.strictEqual(boosted.videos[0].status, 'done')
  })

  await test('no Redis: the video fails at once as unavailable', async () => {
    const w = world({ videos: [queued()], disabled: true })
    await w.run()
    assert.strictEqual(w.jobs.length, 0)
    assert.strictEqual(w.videos[0].error, 'unavailable')
  })

  await test('a dead process claim is taken over, a fresh one is not, a twice-dead one fails', async () => {
    const w = world({
      videos: [
        queued({ _id: 'fresh', status: 'converting', claimedAt: ago(1000), attempts: 1 }),
        queued({ _id: 'stale', status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: 1 }),
        queued({ _id: 'dead', status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: MAX_ATTEMPTS })
      ]
    })
    await w.run()

    assert.deepStrictEqual(w.jobs.map((j) => j.data.fileUrl.length > 0), [true])
    assert.deepStrictEqual(w.videos.map((v) => [v._id, v.status, v.error]), [
      ['fresh', 'converting', undefined],
      ['stale', 'done', undefined],
      ['dead', 'failed', 'timeout']
    ])
  })

  await test('a deploy-sized restart: a claim is stale within a minute, renewed well before', () => {
    assert.ok(CLAIM_STALE_MS <= 60 * 1000)
    assert.ok(HEARTBEAT_MS * 2 < CLAIM_STALE_MS)
  })

  await test('a long conversion keeps its claim fresh and still settles', async () => {
    const w = world({ videos: [queued()], heartbeatMs: 10, outcome: async () => { await sleep(55); return DONE } })
    await w.run()

    assert.ok(w.renewals >= 3, `renewed ${w.renewals} times`)
    assert.strictEqual(w.videos[0].status, 'done')
    assert.deepStrictEqual(w.videos[0].result, WEBM)
  })

  await test('a claim another process took stops the heartbeat, and the late result is dropped', async () => {
    const w = world({
      videos: [queued()],
      heartbeatMs: 10,
      outcome: async () => {
        await sleep(15)
        // This process stalled; another one took the video meanwhile.
        w.videos[0].claimedAt = new Date(0)
        await sleep(40)
        return DONE
      }
    })
    await w.run()
    const renewals = w.renewals

    await sleep(30)
    assert.strictEqual(w.renewals, renewals)
    assert.strictEqual(w.videos[0].status, 'converting')
    assert.strictEqual(w.videos[0].result, undefined)
    assert.ok(w.videos[0].source, 'the other process still needs the file')
  })

  await test('after a restart the video waits on its own job, not a new one', async () => {
    const live = { id: 'job7', opts: { priority: 1 } }
    const w = world({
      videos: [queued({ status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: 1, jobId: 'job7' })],
      redisJobs: { job7: live }
    })
    await w.run()

    assert.strictEqual(w.jobs.length, 0)
    assert.deepStrictEqual(w.followed, ['job7'])
    assert.strictEqual(w.videos[0].status, 'done')
  })

  await test('a job Redis no longer has is started anew, and its id replaces the old one', async () => {
    const w = world({ videos: [queued({ status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: 1, jobId: 'gone' })] })
    await w.run()

    assert.strictEqual(w.jobs.length, 1)
    assert.strictEqual(w.videos[0].jobId, 'job1')
    assert.strictEqual(w.videos[0].status, 'done')
  })

  await test('a job the converter dropped as too old fails as a timeout, not as the video', async () => {
    for (const reason of ['host ::: too_old: waited 700000 ms, limit 600000 ms', 'host ::: Job timeout - older than 600000ms']) {
      const w = world({ videos: [queued()], outcome: { error: 'failed', cause: new Error(reason) } })
      await w.run()
      assert.strictEqual(w.videos[0].error, 'timeout')
    }
  })

  await test('every waiting video starts in one tick, oldest first', async () => {
    const w = world({ videos: [queued({ _id: 'b', createdAt: ago(10) }), queued({ _id: 'a', createdAt: ago(20) })] })
    await w.run()
    assert.deepStrictEqual(w.videos.map((v) => v.status), ['done', 'done'])
    assert.deepStrictEqual(w.jobs.length, 2)
  })

  await test('a job waits in the queue until the converter starts it, and the row says which', async () => {
    let release
    const w = world({ videos: [queued()], outcome: () => new Promise((resolve) => { release = () => resolve(DONE) }), jobState: () => 'waiting' })
    w.converter.start()
    await w.converter.tick()
    await sleep(5)

    // Behind other videos: taken by the bot, not converting yet.
    assert.strictEqual(w.videos[0].status, 'converting')
    assert.strictEqual(w.videos[0].waiting, true)
    assert.strictEqual(w.videos[0].startedAt, undefined)

    // Bull's global:active from whichever process runs the converter's queue.
    w.listeners['global:active']('job1')
    w.listeners['global:active']('someone-elses-job')
    await sleep(5)
    assert.strictEqual(w.videos[0].waiting, undefined)
    assert.ok(w.videos[0].startedAt instanceof Date)

    release()
    await w.converter.settled()
    await w.converter.stop()
    assert.strictEqual(w.videos[0].status, 'done')
  })

  await test('a job the converter took before the event was heard is started on its state', async () => {
    let release
    const w = world({ videos: [queued()], outcome: () => new Promise((resolve) => { release = () => resolve(DONE) }), jobState: () => 'active' })
    await w.converter.tick()
    await sleep(5)
    assert.ok(w.videos[0].startedAt instanceof Date)
    assert.strictEqual(w.videos[0].waiting, undefined)
    release()
    await w.converter.settled()
  })

  await test('a missed event is caught up by the heartbeat', async () => {
    let state = 'waiting'
    const w = world({ videos: [queued()], heartbeatMs: 10, outcome: async () => { await sleep(60); return DONE }, jobState: () => state })
    const run = w.run()
    await sleep(5)
    assert.strictEqual(w.videos[0].waiting, true)
    state = 'active'
    await sleep(30)
    assert.ok(w.videos[0].startedAt instanceof Date)
    await run
  })

  await test('after a restart the job found again says whether it started', async () => {
    const live = { id: 'job7', opts: { priority: 1 }, getState: async () => 'active' }
    const w = world({
      videos: [queued({ status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: 1, jobId: 'job7', waiting: true })],
      redisJobs: { job7: live },
      outcome: async () => { await sleep(10); return DONE }
    })
    const run = w.run()
    await sleep(5)
    assert.ok(w.videos[0].startedAt instanceof Date)
    await run
  })

  await test('a start and an end are one studio_video line each, with the wait and the user\'s hash', async () => {
    const lines = []
    const saved = [console.log, console.warn]
    console.log = console.warn = (line) => { if (String(line).startsWith('{')) lines.push(JSON.parse(line)) }
    process.env.LOG_UID_SALT = 'test-salt'
    try {
      let release
      const w = world({ videos: [queued()], outcome: () => new Promise((resolve) => { release = () => resolve(DONE) }), jobState: () => 'active' })
      await w.converter.tick()
      await sleep(5)
      release()
      await w.converter.settled()

      const failing = world({ videos: [queued({ _id: 'v2' })], outcome: { error: 'timeout' } })
      await failing.run()
    } finally {
      [console.log, console.warn] = saved
      delete process.env.LOG_UID_SALT
    }

    assert.deepStrictEqual(lines.map((line) => [line.kind, line.status, line.level]), [
      ['studio_video', 'started', 'info'],
      ['studio_video', 'done', 'info'],
      ['studio_video', 'failed', 'warn']
    ])
    const [started, done, failure] = lines
    assert.ok(started.waitMs >= 1000 && started.convertMs === undefined)
    assert.ok(done.waitMs === started.waitMs && done.convertMs >= 1 && done.totalMs >= done.waitMs)
    assert.match(done.uid, /^[0-9a-f]{12}$/)
    assert.strictEqual(failure.error, 'timeout')
    assert.strictEqual(failure.waitMs, undefined)
    const text = JSON.stringify(lines)
    assert.ok(!text.includes('key=') && !text.includes('"telegramId"'))
  })

  await test('no salt, no uid', async () => {
    const lines = []
    const saved = console.log
    console.log = (line) => lines.push(JSON.parse(line))
    try {
      await world({ videos: [queued()] }).run()
    } finally {
      console.log = saved
    }
    assert.strictEqual(lines[0].status, 'done')
    assert.ok(!('uid' in lines[0]))
  })

  await test('a tick with every place taken does not stop the ticks after it', async () => {
    const releases = []
    const videos = Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) => queued({ _id: `v${i}`, createdAt: ago(1000 - i) }))
    const w = world({ videos, outcome: () => new Promise((resolve) => releases.push(() => resolve(DONE))) })

    await w.converter.tick()
    assert.strictEqual(videos.filter((v) => v.status === 'converting').length, MAX_IN_FLIGHT)
    // No room: this tick has nothing to wait on.
    await w.converter.tick()

    while (releases.length < MAX_IN_FLIGHT) await sleep(1)
    releases.splice(0).forEach((release) => release())
    await w.converter.settled()
    await w.converter.tick()
    assert.strictEqual(videos[MAX_IN_FLIGHT].status, 'converting')
    while (!releases.length) await sleep(1)
    releases.splice(0).forEach((release) => release())
    await w.converter.settled()
    assert.deepStrictEqual(videos.map((v) => v.status), videos.map(() => 'done'))
  })

  await test('a job state Redis never gives holds nothing up', async () => {
    const live = { id: 'job7', opts: { priority: 1 }, getState: () => new Promise(() => {}) }
    const w = world({
      videos: [queued(), queued({ _id: 'v2', status: 'converting', claimedAt: ago(CLAIM_STALE_MS + 1), attempts: 1, jobId: 'job7' })],
      redisJobs: { job7: live },
      jobState: () => new Promise(() => {}),
      queueLookMs: 10,
      heartbeatMs: 5
    })
    await w.run()
    assert.deepStrictEqual(w.videos.map((v) => v.status), ['done', 'done'])
  })

  await test('an onQueued that never returns does not hold back the job\'s outcome', async () => {
    const queue = { name: 'convert', add: async () => ({ id: 'j1', opts: {}, finished: async () => DONE.result }) }
    const outcome = await runQueueJob(queue, {}, { timeoutMs: 1000, onQueued: () => new Promise(() => {}) })
    assert.deepStrictEqual(outcome, DONE)
  })

  await test('a run past its deadline fails as a timeout and frees its place', () => awake(async () => {
    let late
    const w = world({
      videos: [queued(), queued({ _id: 'v2', createdAt: ago(500) })],
      runDeadlineMs: 20,
      outcome: (data) => (data.fileUrl.includes('v1') ? new Promise((resolve) => { late = () => resolve(DONE) }) : DONE)
    })
    w.videos[1].sourceUrl = 'https://api.fstik.app/studio/video/source?id=v2&key=k'
    await w.run()
    assert.strictEqual(w.videos[0].status, 'failed')
    assert.strictEqual(w.videos[0].error, 'timeout')
    assert.strictEqual(w.videos[1].status, 'done')

    // The conversion that finished after all settles nothing.
    late()
    await sleep(5)
    assert.strictEqual(w.videos[0].status, 'failed')
    assert.strictEqual(w.videos[0].result, undefined)
  }))

  await test('a database write that never returns still gives the place up by the deadline', () => awake(async () => {
    const w = world({ videos: [queued(), queued({ _id: 'v2', createdAt: ago(500) })], runDeadlineMs: 20, setJob: () => new Promise(() => {}) })
    await w.converter.tick()
    await w.converter.settled()
    // The row cannot be written: it stays claimed until the claim goes stale.
    assert.strictEqual(w.videos[0].status, 'converting')
    await w.converter.tick()
    await w.converter.settled()
    assert.strictEqual(w.videos[1].status, 'converting')
    assert.strictEqual(w.jobs.length, 2)
  }))

  await test('a video Studio gave up on fails as a timeout, and the fresh one goes first', async () => {
    const w = world({
      videos: [
        queued({ _id: 'abandoned', createdAt: ago(QUEUE_WAIT_MS + 1) }),
        queued({ _id: 'fresh', createdAt: ago(1000) })
      ]
    })
    await w.run()
    assert.strictEqual(w.jobs.length, 1)
    assert.match(w.jobs[0].data.fileUrl, /source/)
    assert.deepStrictEqual(w.videos.map((v) => [v._id, v.status, v.error]), [
      ['abandoned', 'failed', 'timeout'],
      ['fresh', 'done', undefined]
    ])
    assert.strictEqual(w.videos[0].source, undefined)
  })

  await test('a stopped converter claims nothing', async () => {
    const w = world({ videos: [queued()] })
    await w.converter.stop()
    await w.run()
    assert.strictEqual(w.videos[0].status, 'queued')
  })

  finished = true
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
})()
