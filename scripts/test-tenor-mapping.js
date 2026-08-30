// Unit tests for utils/tenor.js — the Tenor v1 → v2 migration.
//
// v1 (g.tenor.com/v1) is shut down and answers 403 "Tenor API is discontinued",
// which killed every GIF inline query. v2 also changed the payload shape:
// `results[].media[0].<format>.url` became `results[].media_formats.<format>.url`,
// and the request is rejected with 403 unless client_key matches the key.
//
// Everything here runs against a hardcoded v2-shaped fixture and a stubbed
// got.get — no network.

const assert = require('assert')

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

// A real v2 /search response, trimmed to the fields the bot reads.
const V2_FIXTURE = {
  results: [
    {
      id: '15927300081437548692',
      title: '',
      content_description: 'Cat Typing Sticker',
      itemurl: 'https://tenor.com/view/cat-typing-gif-15927300081437548692',
      url: 'https://tenor.com/bZaGF.gif',
      media_formats: {
        gif: { url: 'https://media.tenor.com/abc/cat.gif', dims: [498, 498], size: 1234567 },
        mp4: { url: 'https://media.tenor.com/abc/cat.mp4', dims: [498, 498], size: 234567 },
        gif_transparent: { url: 'https://media.tenor.com/abc/cat-transparent.gif', dims: [498, 498], size: 987654 },
        tinygif_transparent: { url: 'https://media.tenor.com/abc/cat-tiny.gif', dims: [220, 220], size: 45678 }
      }
    },
    {
      // No transparent variants — must still render, falling back to the gif.
      id: '2222222222',
      media_formats: {
        gif: { url: 'https://media.tenor.com/def/dog.gif', dims: [400, 300], size: 111 },
        mp4: { url: 'https://media.tenor.com/def/dog.mp4', dims: [400, 300], size: 222 }
      }
    },
    {
      // No mp4 at all — Telegram can't render an mpeg4_gif result, drop it.
      id: '3333333333',
      media_formats: {
        gif: { url: 'https://media.tenor.com/ghi/bird.gif', dims: [100, 100], size: 333 }
      }
    }
  ],
  next: '20'
}

// Stub got.get before utils/tenor.js pulls it in, so search()/trending() can be
// exercised without touching the network.
const got = require('got')
const calls = []
let nextResponse = { body: JSON.stringify({ results: [], next: '20' }) }
let nextError = null

got.get = async (url) => {
  calls.push(url)
  if (nextError) throw nextError
  return nextResponse
}

const tenor = require('../utils/tenor')

function httpError (statusCode) {
  const err = new Error(`Response code ${statusCode}`)
  err.response = { statusCode }
  return err
}

async function main () {
  process.env.TENOR_KEY = 'TEST_KEY'
  delete process.env.TENOR_CLIENT_KEY

  console.log('\nrequest building\n')

  await test('search hits /v2/search with key, gboard client_key and an encoded query', async () => {
    calls.length = 0
    await tenor.search('cat & dog', 50, 0)

    const url = new URL(calls[0])
    assert.strictEqual(url.origin + url.pathname, 'https://tenor.googleapis.com/v2/search')
    assert.strictEqual(url.searchParams.get('q'), 'cat & dog')
    assert.strictEqual(url.searchParams.get('key'), 'TEST_KEY')
    // Tenor 403s the current key with any other client_key.
    assert.strictEqual(url.searchParams.get('client_key'), 'gboard')
    assert.strictEqual(url.searchParams.get('limit'), '50')
    assert.strictEqual(url.searchParams.get('searchfilter'), 'sticker')
    assert.strictEqual(url.searchParams.get('contentfilter'), 'medium')
    // The raw '&' must be percent-encoded, not treated as a parameter break.
    assert.ok(calls[0].includes('q=cat+%26+dog'), `query not encoded: ${calls[0]}`)
  })

  await test('TENOR_CLIENT_KEY overrides the default', async () => {
    process.env.TENOR_CLIENT_KEY = 'fstikbot'
    calls.length = 0
    await tenor.search('cats', 10, 0)
    assert.strictEqual(new URL(calls[0]).searchParams.get('client_key'), 'fstikbot')
    delete process.env.TENOR_CLIENT_KEY
  })

  await test('trending hits /v2/featured (v1 called it /trending)', async () => {
    calls.length = 0
    await tenor.trending(false, 'uk')

    const url = new URL(calls[0])
    assert.strictEqual(url.origin + url.pathname, 'https://tenor.googleapis.com/v2/featured')
    assert.strictEqual(url.searchParams.get('locale'), 'uk')
    assert.strictEqual(url.searchParams.get('searchfilter'), 'sticker')
    assert.strictEqual(url.searchParams.get('pos'), null, 'no empty pos param')
  })

  await test('media_filter asks for the formats the mapper actually reads', async () => {
    calls.length = 0
    await tenor.search('cats', 10, 0)
    const filter = new URL(calls[0]).searchParams.get('media_filter').split(',')
    for (const format of ['gif', 'mp4', 'gif_transparent', 'tinygif_transparent']) {
      assert.ok(filter.includes(format), `missing ${format} in media_filter`)
    }
  })

  console.log('\nfailure handling\n')

  await test('a missing key fails fast instead of calling Tenor', async () => {
    const key = process.env.TENOR_KEY
    delete process.env.TENOR_KEY
    calls.length = 0
    try {
      await tenor.search('cats', 10, 0)
      throw new Error('expected a throw')
    } catch (err) {
      assert.strictEqual(err.code, 'TENOR_DISABLED')
      assert.strictEqual(calls.length, 0, 'no request was made')
    } finally {
      process.env.TENOR_KEY = key
    }
  })

  for (const status of [400, 401, 403]) {
    await test(`HTTP ${status} surfaces as TENOR_DISABLED, same as a missing key`, async () => {
      nextError = httpError(status)
      try {
        await tenor.search('cats', 10, 0)
        throw new Error('expected a throw')
      } catch (err) {
        assert.strictEqual(err.code, 'TENOR_DISABLED')
        assert.strictEqual(err.statusCode, status)
      } finally {
        nextError = null
      }
    })
  }

  await test('a 500 is NOT swallowed as TENOR_DISABLED', async () => {
    nextError = httpError(500)
    try {
      await tenor.search('cats', 10, 0)
      throw new Error('expected a throw')
    } catch (err) {
      assert.notStrictEqual(err.code, 'TENOR_DISABLED')
    } finally {
      nextError = null
    }
  })

  console.log('\nv2 fixture mapping\n')

  await test('search returns the v2 payload verbatim ({ results, next })', async () => {
    nextResponse = { body: JSON.stringify(V2_FIXTURE) }
    const result = await tenor.search('cats', 50, 0)
    assert.strictEqual(result.next, '20')
    assert.strictEqual(result.results.length, 3)
    nextResponse = { body: JSON.stringify({ results: [], next: '20' }) }
  })

  await test('a full item maps to thumb / mp4 / transparent-gif caption + dims', () => {
    const mapped = tenor.mapResult(V2_FIXTURE.results[0])

    assert.deepStrictEqual(mapped, {
      id: '15927300081437548692',
      thumbUrl: 'https://media.tenor.com/abc/cat-tiny.gif',
      mp4Url: 'https://media.tenor.com/abc/cat.mp4',
      mp4Width: 498,
      mp4Height: 498,
      gifUrl: 'https://media.tenor.com/abc/cat-transparent.gif'
    })
  })

  await test('no transparent variants → falls back to the plain gif', () => {
    const mapped = tenor.mapResult(V2_FIXTURE.results[1])
    assert.strictEqual(mapped.thumbUrl, 'https://media.tenor.com/def/dog.gif')
    assert.strictEqual(mapped.gifUrl, 'https://media.tenor.com/def/dog.gif')
    assert.strictEqual(mapped.mp4Width, 400)
    assert.strictEqual(mapped.mp4Height, 300)
  })

  await test('gif_transparent alone is enough for the caption', () => {
    const mapped = tenor.mapResult({
      id: '4',
      media_formats: {
        gif: { url: 'https://t/gif' },
        mp4: { url: 'https://t/mp4' },
        gif_transparent: { url: 'https://t/transparent' }
      }
    })
    assert.strictEqual(mapped.gifUrl, 'https://t/transparent')
    assert.strictEqual(mapped.thumbUrl, 'https://t/transparent')
  })

  await test('an item without an mp4 is dropped instead of throwing', () => {
    assert.strictEqual(tenor.mapResult(V2_FIXTURE.results[2]), null)
    assert.strictEqual(tenor.mapResult({ id: '5', media_formats: {} }), null)
    assert.strictEqual(tenor.mapResult({ id: '6' }), null)
    assert.strictEqual(tenor.mapResult(null), null)
  })

  await test('missing mp4 dims map to null, not undefined-in-the-payload', () => {
    const mapped = tenor.mapResult({
      id: '7',
      media_formats: { gif: { url: 'https://t/gif' }, mp4: { url: 'https://t/mp4' } }
    })
    assert.strictEqual(mapped.mp4Width, null)
    assert.strictEqual(mapped.mp4Height, null)
  })

  await test('still understands the old v1 media[0] shape', () => {
    const mapped = tenor.mapResult({
      id: '8',
      media: [{ gif: { url: 'https://t/gif' }, mp4: { url: 'https://t/mp4' } }]
    })
    assert.strictEqual(mapped.mp4Url, 'https://t/mp4')
    assert.strictEqual(mapped.gifUrl, 'https://t/gif')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('tenor mapping test OK')
}

main()
