// An update pushed over MTProto must leave nothing behind in gram.js, and
// GetStickerSet must still go through without those stores. No network: the
// login and the sender are stubs.
const assert = require('assert')
process.env.TELEGRAM_API_ID = '1'
process.env.TELEGRAM_API_HASH = 'x'
const { TelegramClient } = require('telegram')
const { _handleUpdate } = require('telegram/client/updates')
const bigInt = require('big-integer')
TelegramClient.prototype.start = async () => {}
const { Api, getClient } = require('../utils/telegram-api')

;(async () => {
  const client = await getClient()

  const user = new Api.User({ id: bigInt(42), accessHash: bigInt(7), firstName: 'A', username: 'a' })
  const update = () => new Api.Updates({ updates: [], users: [user], chats: [], date: 1, seq: 1 })

  for (let i = 0; i < 100; i++) _handleUpdate(client, update())
  assert.strictEqual(client.session._entities.size, 0, 'session keeps no rows')
  assert.strictEqual(client._entityCache.cacheMap.size, 0, 'entity cache keeps nothing')

  const sent = { packs: [], documents: [] }
  client._sender = { send: async () => sent }
  const set = await client.invoke(new Api.messages.GetStickerSet({
    stickerset: new Api.InputStickerSetShortName({ shortName: 'a_by_b' }),
    hash: 0
  }))
  assert.strictEqual(set, sent)
  console.log('test-mtproto-no-entities: ok')
  process.exit(0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
