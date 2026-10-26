// pack-ops: publishing pack drafts (Studio) as resumable commits.
//   plan.js     pure planning: conflicts, content, mapping, moves, metadata
//   execute.js  the commit state machine, with injected telegram/store/lock
//   store.js    MongoDB store, pack lock, uploaded files, records of a new pack
//   names.js    short names for new packs (shared with the /new wizard)
//   title.js    the title as Telegram gets it (limit, bot suffix)
//   fresh.js    a set as Telegram's servers hold it now (MTProto), past the Bot API's copy
// See pack-ops/README.md.

const { runInCopyScope } = require('../utils/retry-api')
const { runCommit, newCommit } = require('./execute')
const { mongoStore, mongoLock, mongoAssets, mongoRegister } = require('./store')
const { createTitleFormatter, createUsernameGetter } = require('./title')
const { createFreshReader } = require('./fresh')
const telegramApi = require('../utils/telegram-api')
const metrics = require('../utils/metrics')
const config = require('../config.json')
const plan = require('./plan')

/**
 * Run a stored commit to the end (or until it can't go on) with the bot's
 * Telegram client. Inside a copy scope: a publish is long and sequential, so
 * it waits out Telegram's per-user cooldowns instead of failing on them.
 *
 * @param {Object} db
 * @param {Object} telegram telegraf Telegram instance
 * @param {string} commitId
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object|null>} the commit, or null if there is none
 */
async function publishCommit (db, telegram, commitId, { onProgress } = {}) {
  const store = mongoStore(db)
  const commit = await store.load(commitId)
  if (!commit) return null
  const assets = mongoAssets(db)
  const botUsername = createUsernameGetter(telegram)
  const formatTitle = createTitleFormatter(telegram, config, botUsername)
  const makeRecords = mongoRegister(db)
  const register = async (made) => {
    const id = await makeRecords(made)
    metrics.track('studio_pack_created')
    return id
  }
  const nameTaken = (name) => db.StickerSet.exists({ name })
  const readFresh = createFreshReader(telegram, telegramApi.getClient, telegramApi.Api)
  return runInCopyScope(() => runCommit(commit, { telegram, store, lock: mongoLock(db), assets, formatTitle, botUsername, nameTaken, register, readFresh, onProgress }))
}

module.exports = {
  plan,
  runCommit,
  newCommit,
  mongoStore,
  mongoLock,
  publishCommit
}
