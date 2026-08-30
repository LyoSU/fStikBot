const got = require('got')

// Tenor API v2. v1 (g.tenor.com/v1) was shut down and answers 403
// "Tenor API is discontinued" — every GIF inline query died on it.
//
// Two things bite on v2 and both are load-bearing:
//   1. The response shape changed: v1 returned `results[].media[0].<format>.url`,
//      v2 returns `results[].media_formats.<format>.url`.
//   2. The key we have is a Gboard key, and Tenor answers 403 unless the request
//      carries `client_key=gboard`. Any other client_key (or none) is rejected.
//
// A 400/401/403 is therefore an expected state, not a crash: the caller answers
// the inline query with an empty result set + a "open the bot" button rather
// than leaving the user on a dead spinner. See handlers/inline-query.js.
const API_BASE = 'https://tenor.googleapis.com/v2'

const apiKey = () => process.env.TENOR_KEY

// Overridable, but 'gboard' is the only value the current key is accepted with.
const clientKey = () => process.env.TENOR_CLIENT_KEY || 'gboard'

// gif/mp4 are what we hand to Telegram; the transparent variants are what the
// "add this GIF as a sticker" path re-downloads (handlers/sticker.js reads the
// caption URL back), and tinygif_transparent is the thumbnail.
const MEDIA_FILTER = 'gif,mp4,gif_transparent,tinygif_transparent'

const TIMEOUT = {
  lookup: 1000,
  connect: 1000,
  secureConnect: 1000,
  socket: 10000,
  send: 10000,
  response: 8000
}

// Raised when Tenor cannot serve us at all: no key configured, or the key /
// client_key combination was rejected. Callers treat every instance the same —
// answer empty, point the user at the bot.
class TenorDisabledError extends Error {
  constructor (message, statusCode = null) {
    super(message)
    this.code = 'TENOR_DISABLED'
    this.statusCode = statusCode
  }
}

const REJECTED_STATUSES = new Set([400, 401, 403])

const request = async (path, params) => {
  const key = apiKey()
  if (!key) throw new TenorDisabledError('TENOR_KEY is not configured')

  const query = new URLSearchParams({
    key,
    client_key: clientKey(),
    media_filter: MEDIA_FILTER,
    ...params
  })

  let response
  try {
    response = await got.get(`${API_BASE}/${path}?${query.toString()}`, {
      timeout: TIMEOUT
    })
  } catch (err) {
    const statusCode = err?.response?.statusCode
    if (REJECTED_STATUSES.has(statusCode)) {
      // Rotated/expired key, or a client_key Tenor doesn't accept. Same class of
      // problem as "no key at all" — nothing the request can do differently.
      throw new TenorDisabledError(`Tenor rejected the request (HTTP ${statusCode})`, statusCode)
    }
    throw err
  }

  return JSON.parse(response.body)
}

const search = async (query, limit, pos) => {
  return request('search', {
    q: query,
    limit,
    // v2 rejects an empty `pos`; 0 is the documented "from the start" value.
    pos: pos || 0,
    searchfilter: 'sticker',
    contentfilter: 'medium'
  })
}

// v2 renamed /v1/trending to /v2/featured.
const trending = async (pos, locale) => {
  const params = {
    limit: 50,
    searchfilter: 'sticker',
    contentfilter: 'medium'
  }
  if (locale) params.locale = locale
  if (pos) params.pos = pos

  return request('featured', params)
}

// v1: item.media[0].<format>.url — v2: item.media_formats.<format>.url.
// Kept here (not in the handler) so the shape of a Tenor item is described in
// exactly one place. Returns null for an item Telegram could not render, so the
// caller filters instead of throwing on a partial payload.
const mapResult = (item) => {
  const formats = item?.media_formats || (Array.isArray(item?.media) ? item.media[0] : null) || {}

  const gifUrl = formats.gif?.url
  const mp4Url = formats.mp4?.url

  if (!gifUrl || !mp4Url) return null

  const dims = Array.isArray(formats.mp4?.dims) ? formats.mp4.dims : null

  return {
    id: item.id,
    // Transparent thumbs preview correctly over any chat background.
    thumbUrl: formats.tinygif_transparent?.url || formats.gif_transparent?.url || gifUrl,
    mp4Url,
    mp4Width: dims ? dims[0] : null,
    mp4Height: dims ? dims[1] : null,
    // Used as the message caption so the "add as sticker" flow can re-download
    // the transparent version; falls back to the plain gif when Tenor didn't
    // return one.
    gifUrl: formats.gif_transparent?.url || gifUrl
  }
}

module.exports = {
  search,
  trending,
  mapResult,
  TenorDisabledError
}
