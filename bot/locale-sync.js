// Locale sync — pushes bot name/description/commands to Telegram for every
// locale in locales/. Idempotent but expensive: up to ~8 API calls per locale
// × 18 locales on every run.
//
// It runs only when the input changed: a hash of every locale file plus this
// file (the command lists live here) is kept in MongoDB. A file-based mtime
// cache never hit in Docker — the dotfile isn't in the image and a fresh
// checkout gives every file a new mtime — so each deploy and restart used to
// fire the whole sync.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales')
const STATE_ID = 'locale-sync'

function computeHash () {
  const hash = crypto.createHash('sha256')
  for (const name of fs.readdirSync(LOCALES_DIR).sort()) {
    hash.update(name).update('\0').update(fs.readFileSync(path.join(LOCALES_DIR, name))).update('\0')
  }
  hash.update(fs.readFileSync(__filename))
  return hash.digest('hex')
}

const stateCollection = (connection) => connection.collection('bot_state')

async function syncOneLocale (bot, i18n, localeName, enDescriptionLong, enDescriptionShort) {
  // NAME
  const name = i18n.t(localeName, 'name')
  const myName = await bot.telegram.callApi('getMyName', { language_code: localeName })
  if (myName.name !== name) {
    try {
      await bot.telegram.callApi('setMyName', { name, language_code: localeName })
      console.log('setMyName', localeName)
    } catch (error) {
      console.error('setMyName', localeName, error.description)
    }
  }

  // LONG DESCRIPTION
  const myDescription = await bot.telegram.callApi('getMyDescription', { language_code: localeName })
  const descriptionLong = i18n.t(localeName, 'description.long')
  const newDescriptionLong = localeName === 'en' || descriptionLong !== enDescriptionLong
    ? descriptionLong.replace(/[\r\n]/gm, '')
    : ''

  if (newDescriptionLong !== myDescription.description.replace(/[\r\n]/gm, '')) {
    try {
      const description = newDescriptionLong ? i18n.t(localeName, 'description.long') : ''
      await bot.telegram.callApi('setMyDescription', { description, language_code: localeName })
      console.log('setMyDescription', localeName)
    } catch (error) {
      console.error('setMyDescription', localeName, error.description)
    }
  }

  // SHORT DESCRIPTION
  const myShortDescription = await bot.telegram.callApi('getMyShortDescription', { language_code: localeName })
  const descriptionShort = i18n.t(localeName, 'description.short')
  const newDescriptionShort = localeName === 'en' || descriptionShort !== enDescriptionShort
    ? descriptionShort.replace(/[\r\n]/gm, '')
    : ''

  if (newDescriptionShort !== myShortDescription.short_description.replace(/[\r\n]/gm, '')) {
    try {
      const shortDescription = newDescriptionShort ? i18n.t(localeName, 'description.short') : ''
      await bot.telegram.callApi('setMyShortDescription', { short_description: shortDescription, language_code: localeName })
      console.log('setMyShortDescription', localeName)
    } catch (error) {
      console.error('setMyShortDescription', localeName, error.description)
    }
  }

  // PRIVATE COMMANDS
  // Slim menu — contextual commands (delete/copy/publish/about/privacy) are
  // available through pack buttons or direct typing, not surfaced in
  // Telegram's command picker.
  const privateCommands = [
    { command: 'start', description: i18n.t(localeName, 'cmd.start.commands.start') },
    { command: 'packs', description: i18n.t(localeName, 'cmd.start.commands.packs') },
    { command: 'new', description: i18n.t(localeName, 'cmd.start.commands.new') },
    { command: 'catalog', description: i18n.t(localeName, 'cmd.start.commands.catalog') },
    { command: 'clear', description: i18n.t(localeName, 'cmd.start.commands.clear') },
    { command: 'round', description: i18n.t(localeName, 'cmd.start.commands.round') },
    { command: 'original', description: i18n.t(localeName, 'cmd.start.commands.original') },
    { command: 'donate', description: i18n.t(localeName, 'cmd.start.commands.donate') },
    { command: 'lang', description: i18n.t(localeName, 'cmd.start.commands.lang') }
  ]

  const myCommandsInPrivate = await bot.telegram.callApi('getMyCommands', {
    language_code: localeName,
    scope: JSON.stringify({ type: 'all_private_chats' })
  })

  let needUpdatePrivate = myCommandsInPrivate.length !== privateCommands.length
  if (!needUpdatePrivate) {
    for (const cmd of privateCommands) {
      const existing = myCommandsInPrivate.find(c => c.command === cmd.command)
      if (!existing || existing.description !== cmd.description) {
        needUpdatePrivate = true
        break
      }
    }
  }

  if (needUpdatePrivate) {
    await bot.telegram.callApi('setMyCommands', {
      commands: privateCommands,
      language_code: localeName,
      scope: JSON.stringify({ type: 'all_private_chats' })
    })
  }

  // GROUP COMMANDS
  const groupCommands = [
    { command: 'ss', description: i18n.t(localeName, 'cmd.start.commands.ss') },
    { command: 'packs', description: i18n.t(localeName, 'cmd.start.commands.packs') }
  ]

  const myCommandsInGroup = await bot.telegram.callApi('getMyCommands', {
    language_code: localeName,
    scope: JSON.stringify({ type: 'all_group_chats' })
  })

  let needUpdateGroup = myCommandsInGroup.length !== groupCommands.length
  if (!needUpdateGroup) {
    for (const cmd of groupCommands) {
      const existing = myCommandsInGroup.find(c => c.command === cmd.command)
      if (!existing || existing.description !== cmd.description) {
        needUpdateGroup = true
        break
      }
    }
  }

  if (needUpdateGroup) {
    await bot.telegram.callApi('setMyCommands', {
      commands: groupCommands,
      language_code: localeName,
      scope: JSON.stringify({ type: 'all_group_chats' })
    })
  }
}

module.exports = async function syncLocales (bot, i18n, connection) {
  const hash = computeHash()
  const state = await stateCollection(connection).findOne({ _id: STATE_ID }).catch(() => null)

  if (state && state.hash === hash) {
    console.log('[locale-sync] locales unchanged since last sync — skipping')
    return
  }

  console.log('[locale-sync] locales changed, running full sync')

  const enDescriptionLong = i18n.t('en', 'description.long')
  const enDescriptionShort = i18n.t('en', 'description.short')

  // One locale at a time: a burst of ~140 calls at boot competes with real
  // users for the bot's rate limits, and nothing waits on this sync.
  let failed = 0
  const locales = fs.readdirSync(LOCALES_DIR)
  for (const locale of locales) {
    await syncOneLocale(bot, i18n, locale.split('.')[0], enDescriptionLong, enDescriptionShort)
      .catch((err) => {
        failed++
        console.warn('[locale-sync]', locale, err.description || err.message)
      })
  }

  if (failed > 0) {
    console.warn(`[locale-sync] ${failed}/${locales.length} locale(s) failed — not saving the hash, will retry next boot`)
    return
  }

  await stateCollection(connection).updateOne({ _id: STATE_ID }, { $set: { hash, syncedAt: new Date() } }, { upsert: true })
    .catch((err) => console.warn('[locale-sync] failed to save the hash:', err.message))
  console.log('[locale-sync] completed successfully')
}
