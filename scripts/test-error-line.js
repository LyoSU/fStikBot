// Unit tests for utils/fingerprint.js and utils/error-line.js: the JSON error
// lines the log shipper reads, and the fingerprint they share with the API.

const assert = require('assert')
const { scrub, normalize, topFrame, fingerprint } = require('../utils/fingerprint')
const { errorLine, logError, contextOf, isUserCaused } = require('../utils/error-line')
const { commitCode, logOutcome } = require('../pack-ops/worker')

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
    console.log(`        ${error.message}`)
  }
}

const tgError = (code, description) => Object.assign(new Error(`${code}: ${description}`), { code, description })

// Captures the lines logError writes instead of printing them.
function capture (run) {
  const lines = []
  const saved = [console.error, console.warn]
  console.error = (line) => lines.push(['error', line])
  console.warn = (line) => lines.push(['warn', line])
  try {
    run()
  } finally {
    [console.error, console.warn] = saved
  }
  return lines
}

const webkit = 'TypeError: x\nxe@https://studio.fstik.app/assets/index-AbCd123456.js:1:2345'
const node = 'Error: boom 7\n    at handler (/app/handlers/sticker.js:10:5)'

test('fingerprints match the API module\'s for the same input', () => {
  // Computed with fstikbot-api utils/studio/fingerprint.js.
  assert.strictEqual(fingerprint('render', 'TypeError: frame 12 failed', webkit), '28daf9365501')
  assert.strictEqual(fingerprint('bot', 'Error: boom 7', node), '5fafb7b0a100')
})

test('a fingerprint ignores numbers, hashes, line and column, not the place', () => {
  const a = fingerprint('bot', 'Error: boom 7', node)
  assert.strictEqual(a, fingerprint('bot', 'Error: boom 99', node.replace('10:5', '12:9')))
  assert.notStrictEqual(a, fingerprint('pack-ops:tick', 'Error: boom 7', node))
  assert.strictEqual(topFrame(webkit), 'xe@/assets/index.js:<n>:<n>')
  assert.strictEqual(normalize('job 6adf7fda4c68a7a1a322ea29 x'), 'job <id> x')
})

test('scrub takes out bot tokens and initData fields', () => {
  const text = scrub('GET /bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ1/getMe ?hash=abc&user=%7B%22id%22')
  assert.ok(!text.includes('AAHdq'))
  assert.ok(text.includes('hash=<redacted>'))
  assert.ok(text.includes('user=<redacted>'))
})

test('a bot error is one JSON line without user ids, pack names or text', () => {
  const error = new Error('no pack cats_by_fStikBot for user 123456789')
  const ctx = {
    updateType: 'message',
    message: { text: '/copy@fStikBot cats_by_fStikBot secret words' },
    chat: { type: 'private', id: 123456789 },
    from: { id: 123456789, username: 'someone' },
    scene: { current: { id: 'packCopy' } }
  }
  const text = errorLine(error, { where: 'bot', context: contextOf(ctx) })
  const line = JSON.parse(text)

  assert.ok(!text.includes('\n'))
  assert.deepStrictEqual(Object.keys(line), ['level', 'kind', 'release', 'fp', 'where', 'message', 'stack', 'context'])
  assert.strictEqual(line.level, 'error')
  assert.strictEqual(line.kind, 'bot_error')
  assert.strictEqual(line.release, 'dev')
  assert.deepStrictEqual(line.context, { updateType: 'message', command: 'copy', scene: 'packCopy', chatType: 'private' })
  assert.strictEqual(line.message, 'Error: no pack <pack> for user <id>')
  for (const leak of ['123456789', 'cats_by', 'someone', 'secret']) assert.ok(!text.includes(leak), leak)
})

test('a callback names its handler by the data\'s prefix only', () => {
  assert.deepStrictEqual(contextOf({ updateType: 'callback_query', callbackQuery: { data: 'catalog:publish:cats_by_x' }, chat: { type: 'private' } }),
    { updateType: 'callback_query', command: undefined, handler: 'catalog', scene: undefined, chatType: 'private' })
})

test('Telegram errors users cause are warnings with their code', () => {
  for (const description of ['Forbidden: bot was blocked by the user', 'Bad Request: message is not modified: specified new message content', 'Bad Request: query is too old and response timeout expired']) {
    const error = tgError(description.startsWith('Forbidden') ? 403 : 400, description)
    assert.strictEqual(isUserCaused(error), true, description)
    const lines = capture(() => logError(error, { where: 'bot' }))
    assert.strictEqual(lines[0][0], 'warn')
    const line = JSON.parse(lines[0][1])
    assert.strictEqual(line.level, 'warn')
    assert.strictEqual(typeof line.tgCode, 'number')
  }
  const bug = capture(() => logError(tgError(400, 'Bad Request: STICKERSET_INVALID'), { where: 'bot' }))
  assert.strictEqual(bug[0][0], 'error')
  assert.strictEqual(JSON.parse(bug[0][1]).tgDescription, 'Bad Request: STICKERSET_INVALID')
})

test('SOURCE_COMMIT names the release', () => {
  process.env.SOURCE_COMMIT = '0123456789abcdef0123'
  try {
    assert.strictEqual(JSON.parse(errorLine(new Error('x'), { where: 'bot' })).release, '0123456789ab')
  } finally {
    delete process.env.SOURCE_COMMIT
  }
})

test('a commit\'s failure code is stable across commits', () => {
  assert.strictEqual(commitCode('copy_missing'), 'copy_missing')
  assert.strictEqual(commitCode('Bad Request: STICKERSET_INVALID'), 'STICKERSET_INVALID')
  assert.strictEqual(commitCode('the pack changed outside the draft'), 'the pack changed outside the draft')
  assert.strictEqual(commitCode('timeout after 30000 ms on cats_by_bot'), 'timeout after <n> ms on <pack>')
  assert.strictEqual(commitCode(null), 'unknown')
})

test('a failed or conflicting commit is one pack_commit line, a published one none', () => {
  const commit = { _id: 'abc', status: 'conflict', error: 'the pack changed outside the draft', name: 'cats_by_bot', ownerTelegramId: 123456789, phase: 'content' }
  const lines = capture(() => {
    logOutcome(commit)
    logOutcome({ ...commit, status: 'failed', create: {}, error: 'Bad Request: STICKERS_TOO_MUCH' })
    logOutcome({ ...commit, status: 'succeeded' })
  })

  assert.strictEqual(lines.length, 2)
  const conflict = JSON.parse(lines[0][1])
  assert.strictEqual(lines[0][0], 'warn')
  assert.strictEqual(conflict.kind, 'pack_commit')
  assert.deepStrictEqual(
    [conflict.status, conflict.code, conflict.op, conflict.phase, conflict.commitId],
    ['conflict', 'the pack changed outside the draft', 'edit', 'content', 'abc'])
  const failure = JSON.parse(lines[1][1])
  assert.deepStrictEqual([lines[1][0], failure.code, failure.op], ['error', 'STICKERS_TOO_MUCH', 'create'])
  assert.ok(!lines.join(' ').includes('cats_by') && !lines.join(' ').includes('123456789'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
