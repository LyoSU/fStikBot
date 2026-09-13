// GramAds ad post for ru-locale users of non-boosted packs. Optional: no
// token → no request. Fire-and-forget at every call site, so failures only
// log — but the request itself must not hang a libuv slot forever.
const got = require('got')
const log = require('./logger').scope('gramads')

module.exports = async (chatId) => {
  const token = process.env.GRAMADS_TOKEN
  if (!token) return

  try {
    const response = await got.post('https://api.gramads.net/ad/SendPost', {
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json'
      },
      json: { SendToChatId: chatId },
      timeout: { request: 5000 },
      retry: 0
    })
    return response.body
  } catch (err) {
    log.warn(`SendPost failed for ${chatId}: ${err.message}`)
  }
}
