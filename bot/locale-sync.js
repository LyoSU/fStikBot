// Locale sync — pushes bot name/description/commands to Telegram for every
// locale in locales/. This is idempotent but expensive: up to ~8 API calls
// per locale × 18 locales = ~144 calls on every process start.
//
// PM2 restarts the process every 6h, which used to trigger the whole sync.
// We now cache a hash of the locales/ directory's max mtime in a dotfile;
// if nothing changed since last run, sync is skipped entirely.
const fs = require('fs')
const path = require('path')

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales')
const CACHE_FILE = path.resolve(__dirname, '..', '.locale-sync-mtime')

function computeMaxMtime () {
  let max = 0
  for (const name of fs.readdirSync(LOCALES_DIR)) {
    const stat = fs.statSync(path.join(LOCALES_DIR, name))
    if (stat.mtimeMs > max) max = stat.mtimeMs
  }
  return Math.floor(max)
}

function readCachedMtime () {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8').trim()
    return parseInt(raw, 10) || 0
  } catch {
    return 0
  }
}

function writeCachedMtime (mtime) {
  try {
    fs.writeFileSync(CACHE_FILE, String(mtime))
  } catch (err) {
    console.warn('[locale-sync] failed to persist mtime cache:', err.message)
  }
}

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

module.exports = async function syncLocales (bot, i18n) {
  const currentMtime = computeMaxMtime()
  const cachedMtime = readCachedMtime()

  if (currentMtime === cachedMtime) {
    console.log('[locale-sync] locales unchanged since last run — skipping')
    return
  }

  console.log('[locale-sync] locales changed, running full sync')

  const locales = fs.readdirSync(LOCALES_DIR)
  const enDescriptionLong = i18n.t('en', 'description.long')
  const enDescriptionShort = i18n.t('en', 'description.short')

  const results = await Promise.allSettled(locales.map((locale) => {
    const localeName = locale.split('.')[0]
    return syncOneLocale(bot, i18n, localeName, enDescriptionLong, enDescriptionShort)
  }))

  const failed = results.filter(r => r.status === 'rejected').length
  if (failed > 0) {
    console.warn(`[locale-sync] ${failed}/${results.length} locale(s) failed — not caching mtime, will retry next boot`)
    return
  }

  writeCachedMtime(currentMtime)
  console.log('[locale-sync] completed successfully')
}
