// Tests for utils/download-file-by-url.js against a local HTTP server: every
// download must settle — a stalled, dropped or trickling response included.

const assert = require('assert')
const http = require('http')
const downloadFileByUrl = require('../utils/download-file-by-url')

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

const routes = {
  '/ok': (req, res) => res.end('hello'),
  '/404': (req, res) => { res.statusCode = 404; res.end() },
  // Headers, part of the body, then silence.
  '/stall': (req, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.write('part') },
  // Headers, part of the body, then the connection is cut.
  '/drop': (req, res) => {
    res.writeHead(200, { 'Content-Length': 100 })
    res.write('part', () => setTimeout(() => res.socket.destroy(), 20))
  },
  // A byte every 50 ms forever: never idle, never done.
  '/trickle': (req, res) => {
    res.writeHead(200)
    const timer = setInterval(() => res.write('x'), 50)
    res.on('close', () => clearInterval(timer))
  },
  '/big': (req, res) => {
    res.writeHead(200)
    const chunk = Buffer.alloc(1024 * 1024)
    let sent = 0
    const pump = () => {
      while (sent < 25 && res.write(chunk)) sent++
      if (sent < 25) res.once('drain', pump)
      else res.end()
    }
    pump()
  }
}

// Settles within `ms`, or fails the test instead of hanging the run.
const within = (promise, ms) => Promise.race([
  promise,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms))
])

const rejectsWith = async (promise, pattern) => {
  const error = await within(promise, 3000).then(() => null, (err) => err)
  assert.ok(error, 'expected a rejection')
  assert.ok(pattern.test(error.message), `unexpected error: ${error.message}`)
}

const server = http.createServer((req, res) => routes[req.url](req, res))

server.listen(0, '127.0.0.1', async () => {
  const url = (path) => `http://127.0.0.1:${server.address().port}${path}`

  await test('downloads a file', async () => {
    const data = await within(downloadFileByUrl(url('/ok')), 3000)
    assert.strictEqual(data.toString(), 'hello')
  })

  await test('rejects a non-200 status', () => rejectsWith(downloadFileByUrl(url('/404')), /status 404/))

  await test('rejects a response that stalls mid-body', () =>
    rejectsWith(downloadFileByUrl(url('/stall'), 300), /timeout/i))

  await test('rejects a connection cut mid-body', () =>
    rejectsWith(downloadFileByUrl(url('/drop'), 2000), /download/i))

  await test('rejects a response that trickles past the deadline', () =>
    rejectsWith(downloadFileByUrl(url('/trickle'), 400), /timeout/i))

  await test('rejects a file over the size limit', () =>
    rejectsWith(downloadFileByUrl(url('/big')), /too large/))

  server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})
