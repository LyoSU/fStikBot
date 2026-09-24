// GramAds ad post for ru-locale users of non-boosted packs. Optional: no
// token → no request. Fire-and-forget at every call site, so failures only
// log — but the request itself must not hang a libuv slot forever.
const log = require('./logger').scope('gramads')

module.exports = async (chatId) => {
  const token = process.env.GRAMADS_TOKEN
  if (!token) return

  try {
    const response = await fetch('https://api.gramads.net/ad/SendPost', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ SendToChatId: chatId }),
      signal: AbortSignal.timeout(5000)
    })
    // got threw on non-2xx; keep that, so a rejected post still logs below.
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } catch (err) {
    log.warn(`SendPost failed for ${chatId}: ${err.message}`)
  }
}
