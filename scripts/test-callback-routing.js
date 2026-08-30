// Regression tests for the callback_data / command regexes registered in
// bot/commands.js and the scene exit-command list in scenes/index.js.
//
// The routing bugs these cover were invisible in code review because telegraf
// matches an unanchored regex anywhere in the string: /publish/ swallowed
// `catalog:publish:<id>`, and hears(/\/new/) swallowed pack links containing
// "/new". Runs without a DB or a Telegram connection — it only parses the
// source and replays the regexes.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

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

// Turn a `/pattern/flags` literal lifted out of the source into a real RegExp.
// Deliberately NOT eval: the input is a source file, and there is no reason to
// let anything but a regex body through.
function toRegExp (literal, flags = '') {
  const body = literal.replace(/^\//, '').replace(/\/$/, '')
  return new RegExp(body, flags)
}

const commandsSrc = fs.readFileSync(path.resolve(__dirname, '../bot/commands.js'), 'utf8')
const scenesSrc = fs.readFileSync(path.resolve(__dirname, '../scenes/index.js'), 'utf8')

// Pull `privateMessage.action(/.../, ...)` / `bot.action(...)` regex literals in
// registration order — that order is what decides which handler wins.
function registeredActionRegexes (src) {
  const out = []
  const re = /\.action\((\/(?:\\.|\[[^\]]*\]|[^/\\])+\/)([a-z]*)\s*,/g
  for (const m of src.matchAll(re)) {
    out.push({ source: m[1], regex: toRegExp(m[1], m[2]) })
  }
  return out
}

const actions = registeredActionRegexes(commandsSrc)

// Which registered action regex fires first for this callback_data?
function firstMatch (data) {
  const hit = actions.find(({ regex }) => regex.test(data))
  return hit ? hit.source : null
}

function main () {
  console.log('\ncallback routing\n')

  // Every callback_data the bot actually produces must still reach a handler,
  // and it must be the RIGHT one.
  const expectations = [
    ['publish', '/^publish$/'],
    ['catalog:publish:65f0000000000000000000aa', '/^catalog:publish:(.*)$/'],
    ['catalog:unpublish:65f0000000000000000000aa', '/^catalog:unpublish:(.*)$/'],
    ['pack_about', '/^(about|pack_about)$/'],
    ['set_frame', '/^(frame|set_frame)$/'],
    ['search_catalog', '/^search_catalog$/'],
    ['add_sticker', '/^add_sticker$/'],
    ['delete_sticker', '/^delete_sticker$/'],
    ['original', '/^original$/'],
    ['catalog', '/^catalog$/'],
    ['download_original', '/^download_original$/'],
    ['show_all_packs', '/^show_all_packs$/'],
    ['new_pack:inline', '/new_pack:(.*)/'],
    ['new_pack:null', '/new_pack:(.*)/'],
    ['delete_pack:65f0000000000000000000aa', '/delete_pack:(.*)/'],
    ['mosaic:enter', null], // registered with a string, not a regex
    ['set_language:uk', '/^set_language:(.*)$/']
  ]

  for (const [data, expected] of expectations) {
    test(`${data} → ${expected === null ? '(string handler)' : expected}`, () => {
      assert.strictEqual(firstMatch(data), expected)
    })
  }

  test('catalog buttons are not swallowed by the /publish handler', () => {
    const publish = actions.find((a) => a.source === '/^publish$/')
    assert.ok(publish, '/^publish$/ is registered')
    assert.strictEqual(publish.regex.test('catalog:publish:abc'), false)
    assert.strictEqual(publish.regex.test('catalog:unpublish:abc'), false)
    assert.strictEqual(publish.regex.test('broadcast:new:publish'), false)
  })

  console.log('\n/new command matching\n')

  const newHears = commandsSrc.match(/privateMessage\.hears\((\/\^\\\/new[^,]+?\/)[a-z]*,/)
  test('the /new hears regex is anchored', () => {
    assert.ok(newHears, 'found the /new hears registration')
  })

  if (newHears) {
    const newRe = toRegExp(newHears[1])

    const shouldMatch = ['/new', '/new@fStikBot', '/new fill', '/new adaptive']
    const shouldNotMatch = [
      'https://t.me/addstickers/newyear_by_fStikBot',
      't.me/addstickers/new_pack_by_fStikBot',
      'look at /newsletter',
      'renew'
    ]

    for (const text of shouldMatch) {
      test(`matches ${JSON.stringify(text)}`, () => assert.strictEqual(newRe.test(text), true))
    }
    for (const text of shouldNotMatch) {
      test(`ignores ${JSON.stringify(text)}`, () => assert.strictEqual(newRe.test(text), false))
    }
  }

  console.log('\nscene exit commands\n')

  const exitMatch = scenesSrc.match(/const EXIT_COMMANDS = (\/\^[^\n]+?\/)\n/)
  test('EXIT_COMMANDS regex is exported from scenes/index.js', () => {
    assert.ok(exitMatch, 'found EXIT_COMMANDS')
  })

  if (exitMatch) {
    const exitRe = toRegExp(exitMatch[1])

    const leaves = [
      '/start', '/start s_deadbeef', '/packs', '/packs@fStikBot',
      '/new', '/new fill', '/boost', '/public', '/ss', '/donate', '/mosaic'
    ]
    const stays = ['/boosted', 'my /start pack', 'ss', '/publicity', 'Cats :: @fStikBot']

    for (const text of leaves) {
      test(`leaves the scene on ${JSON.stringify(text)}`, () => assert.strictEqual(exitRe.test(text), true))
    }
    for (const text of stays) {
      test(`stays in the scene on ${JSON.stringify(text)}`, () => assert.strictEqual(exitRe.test(text), false))
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('callback routing test OK')
}

main()
