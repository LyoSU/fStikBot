const fs = require('fs')
const sharp = require('sharp')
const path = require('path')
const Telegraf = require('telegraf')
const Composer = require('telegraf/composer')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
const got = require('got')
const {
  db
} = require('./database')
const {
  handleError,
  handleStats,
  handlePing,
  handleStart,
  handleHelp,
  handleDonate,
  handleSticker,
  handleDeleteSticker,
  handleRestoreSticker,
  handlePacks,
  handleSelectPack,
  handleSelectGroupPack,
  handleHidePack,
  handleRestorePack,
  handleBoostPack,
  handleCatalog,
  handleSearchCatalog,
  handleGuide,
  handleCopyPack,
  handleCoedit,
  handleLanguage,
  handleEmoji,
  handleStickerUpade,
  handleInlineQuery,
  handleGroupSettings
} = require('./handlers')
const scenes = require('./scenes')
const {
  updateUser,
  updateGroup,
  stats,
  updateMonitor,
  downloadFileByURL,
  retryMiddleware
} = require('./utils')

global.startDate = new Date()

// init bot
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    webhookReply: false
  },
  handlerTimeout: 1000
})

bot.catch(handleError)

// if channel post
bot.on(['channel_post', 'edited_channel_post', 'poll'], () => {})

// I18n
const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

bot.use(i18n)

// Auto-retry on 429 rate limit errors
bot.use(retryMiddleware())

const limitPublicPack = Composer.optional((ctx) => {
  return ctx?.session?.userInfo?.stickerSet?.passcode === 'public'
}, rateLimit({
  window: 1000 * 60,
  limit: 1,
  onLimitExceeded: (ctx) => ctx.reply(ctx.i18n.t('ratelimit'))
}))

bot.use(stats)

// bot config
bot.context.config = require('./config.json')

// db connect
bot.context.db = db

// Session store with TTL-based cleanup (more memory efficient)
const sessionStore = new Map()
const sessionTimestamps = new Map()
const SESSION_TTL = 1000 * 60 * 60 // 1 hour TTL
const SESSION_MAX_SIZE = 100000 // Max sessions to prevent memory bloat

// Cleanup expired sessions every 2 minutes
setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [key, timestamp] of sessionTimestamps) {
    if (now - timestamp > SESSION_TTL) {
      sessionStore.delete(key)
      sessionTimestamps.delete(key)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`Session cleanup: removed ${cleaned} expired sessions, ${sessionStore.size} active`)
  }
}, 1000 * 60 * 2)

// Evict oldest sessions if limit reached
function evictOldestSessions (count) {
  const sorted = [...sessionTimestamps.entries()].sort((a, b) => a[1] - b[1])
  for (let i = 0; i < count && i < sorted.length; i++) {
    sessionStore.delete(sorted[i][0])
    sessionTimestamps.delete(sorted[i][0])
  }
}

// Wrap session store to track timestamps
const sessionStoreWrapper = {
  get: (key) => {
    sessionTimestamps.set(key, Date.now())
    return sessionStore.get(key)
  },
  set: (key, value) => {
    // Evict 10% oldest if at capacity
    if (sessionStore.size >= SESSION_MAX_SIZE) {
      evictOldestSessions(Math.floor(SESSION_MAX_SIZE * 0.1))
    }
    sessionTimestamps.set(key, Date.now())
    return sessionStore.set(key, value)
  },
  delete: (key) => {
    sessionTimestamps.delete(key)
    return sessionStore.delete(key)
  }
}

bot.use(
  session({
    store: sessionStoreWrapper,
    getSessionKey: (ctx) => {
      if ((ctx.from && ctx.chat && ctx.chat.id === ctx.from.id) || (!ctx.chat && ctx.from)) {
        return `user:${ctx.from.id}`
      } else if (ctx.from && ctx.chat) {
        return `${ctx.from.id}:${ctx.chat.id}`
      }
      return ctx.update.update_id
    }
  })
)

// response time logger
bot.use(async (ctx, next) => {
  if (ctx.session && !ctx.session.chainActions) ctx.session.chainActions = []
  let action

  if (ctx.message && ctx.message.text) action = ctx.message.text
  else if (ctx.callbackQuery) action = ctx.callbackQuery.data
  else if (ctx.updateType) action = `{${ctx.updateType}} `

  if (ctx.updateSubTypes) action += ` [${ctx.updateSubTypes.join(', ')}]`

  if (!action) action = 'undefined'

  if (ctx.session.chainActions.length > 15) ctx.session.chainActions.shift()
  ctx.session.chainActions.push(action)


  // const ms = new Date()
  if (ctx.inlineQuery) {
    await updateUser(ctx)
    ctx.state.answerIQ = []
  }
  if (ctx.callbackQuery) ctx.state.answerCbQuery = []
  return next(ctx).then(() => {
    if (ctx.callbackQuery) return ctx.answerCbQuery(...ctx.state.answerCbQuery)
  })
})

bot.use(Composer.groupChat(Composer.command(updateGroup)))

bot.command('json', ({ replyWithHTML, message }) =>
  replyWithHTML('<code>' + JSON.stringify(message, null, 2) + '</code>')
)

bot.use((ctx, next) => {
  // лагідна українізація
  if (
    ctx?.session?.userInfo?.locale === 'ru' &&
    ctx.from.language_code === 'uk'
  ) {
    ctx.session.userInfo.locale = 'uk'
    ctx.session.userInfo.save().catch(() => {})
    ctx.i18n.locale('uk')
  }
  return next()
})

bot.use((ctx, next) => {
  if (ctx?.session?.userInfo?.banned) {
    return ctx.replyWithHTML(ctx.i18n.t('error.banned'))
  }
  return next()
})


bot.use(async (ctx, next) => {
  await updateUser(ctx)
  await next(ctx)
  if (ctx.session.userInfo) await ctx.session.userInfo.save().catch(() => {})
})

bot.use((ctx, next) => {
  if (ctx.update.my_chat_member) return false
  else return next()
})

const privateMessage = new Composer()
privateMessage.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type === 'private') return next()
  return false
})

// scene
bot.use(scenes)

privateMessage.use(require('./handlers/admin'))
privateMessage.use(require('./handlers/news-channel'))

bot.use(handleStats)
bot.use(handlePing)

// main commands
bot.start(async (ctx, next) => {
  if (ctx.startPayload === 'inline_pack') {
    ctx.state.type = 'inline'
    return handlePacks(ctx)
  }
  if (ctx.startPayload === 'pack') {
    return handlePacks(ctx)
  }

  if (ctx.startPayload.startsWith('removebg_')) {
    const fileUrl = 'https://telegra.ph' + Buffer.from(ctx?.startPayload?.replace('removebg_', ''), 'base64').toString('utf-8')

    const file = await downloadFileByURL(fileUrl)

    const webp = await sharp(file).webp().toBuffer()

    return ctx.replyWithDocument({
      source: webp,
      filename: 'removebg.webp'
    }, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: ctx.i18n.t('scenes.photoClear.add_to_set_btn'),
              callback_data: 'add_sticker'
            }
          ]
        ]
      }
    })
  }
  return next()
})
privateMessage.command('help', handleHelp)
bot.command('packs', handlePacks)
bot.command('pack', handleSelectGroupPack)

bot.use(handleGroupSettings)

privateMessage.action(/packs:(type):(.*)/, handlePacks)
privateMessage.action(/packs:(.*)/, handlePacks)

bot.start((ctx, next) => {
  if (ctx.startPayload.match(/^s_(.*)/)) return handleSelectPack(ctx)
  if (ctx.startPayload === 'packs') return handlePacks(ctx)
  return next()
})


privateMessage.command('paysupport', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.paysupport')))

// Cache privacy.html at startup
const privacyHtml = fs.readFileSync(path.resolve(__dirname, 'privacy.html'), 'utf-8')
privateMessage.command('privacy', (ctx) => ctx.replyWithHTML(privacyHtml))

// Pack link handler chain: restore (if owner) → copy (if not owner)
privateMessage.hears(/(addstickers|addemoji)\/(.*)/, handleRestorePack)

privateMessage.command('report', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.report')))
privateMessage.hears(/\/new/, (ctx) => ctx.scene.enter('newPack'))
privateMessage.action(/new_pack:(.*)/, (ctx) => {
  const packType = ctx.match[1]
  if (packType === 'inline') {
    ctx.session.scene = ctx.session.scene || {}
    ctx.session.scene.newPack = {
      inline: true,
      packType: 'regular'
    }
  }
  return ctx.scene.enter('newPack')
})
privateMessage.hears(/(addstickers|addemoji)\/(.*)/, handleCopyPack)
privateMessage.command('publish', (ctx) => ctx.scene.enter('catalogPublishNew'))
privateMessage.action(/publish/, (ctx) => ctx.scene.enter('catalogPublishNew'))
privateMessage.command('frame', (ctx) => ctx.scene.enter('packFrame'))
privateMessage.action(/frame/, (ctx) => ctx.scene.enter('packFrame'))
privateMessage.command('delete', (ctx) => ctx.scene.enter('deleteSticker'))
privateMessage.action(/^delete_sticker$/, (ctx) => ctx.scene.enter('deleteSticker'))
privateMessage.command('catalog', handleCatalog)
privateMessage.action(/search_catalog/, handleSearchCatalog)
privateMessage.action(/^catalog$/, handleCatalog)
privateMessage.action(/guide:(.*)/, handleGuide)
privateMessage.command('public', handleSelectPack)
privateMessage.command('emoji', handleEmoji)
privateMessage.command('copy', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.copy')))
privateMessage.command('restore', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.restore')))
privateMessage.command('original', (ctx) => ctx.scene.enter('originalSticker'))
privateMessage.action(/^original$/, (ctx) => ctx.scene.enter('originalSticker'))
privateMessage.command('about', (ctx) => ctx.scene.enter('packAbout'))
privateMessage.action(/about/, (ctx) => ctx.scene.enter('packAbout'))
privateMessage.action(/^download_original$/, async (ctx) => {
  await ctx.answerCbQuery()

  const sticker = ctx.session?.lastStickerForDownload
  if (!sticker) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'))
  }

  // Query supports both new (original) and legacy (file) schema
  const stickerInfo = await db.Sticker.findOne({
    fileUniqueId: sticker.file_unique_id,
    $or: [
      { 'original.fileId': { $ne: null } },
      { 'file.file_id': { $ne: null } }
    ]
  })

  if (stickerInfo && stickerInfo.hasOriginal()) {
    const originalFileId = stickerInfo.getOriginalFileId()
    const originalFileUniqueId = stickerInfo.getOriginalFileUniqueId()

    await ctx.replyWithSticker(originalFileId, {
      caption: stickerInfo.emojis
    }).catch(async (stickerError) => {
      if (stickerError.description.match(/emoji/)) {
        const fileLink = await ctx.telegram.getFileLink(originalFileId)
        await ctx.replyWithDocument({
          url: fileLink,
          filename: `${originalFileUniqueId}.webp`
        }).catch((error) => {
          ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: error.description }))
        })
      } else {
        ctx.replyWithPhoto(originalFileId, {
          caption: stickerInfo.emojis
        }).catch((photoError) => {
          ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: photoError.description }))
        })
      }
    })
  } else {
    const fileLink = await ctx.telegram.getFileLink(sticker.file_id)

    if (fileLink.endsWith('.webp')) {
      const buffer = await got(fileLink).buffer()
      const pngBuffer = await sharp(buffer, { failOnError: false }).png().toBuffer()
      await ctx.replyWithDocument({
        source: pngBuffer,
        filename: `${sticker.file_unique_id}.png`
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: error.description }))
      })
    } else if (fileLink.endsWith('.webm')) {
      await ctx.replyWithDocument({
        url: fileLink,
        filename: `${sticker.file_unique_id}.webm`
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: error.description }))
      })
    } else if (fileLink.endsWith('.tgs')) {
      await ctx.replyWithDocument({
        url: fileLink,
        filename: `${sticker.file_unique_id}.tgs`
      }).catch((error) => {
        ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: error.description }))
      })
    } else {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'))
    }
  }
})
privateMessage.action(/^show_all_packs$/, async (ctx) => {
  await ctx.answerCbQuery()

  const data = ctx.session?.showAllPacksData
  if (!data) {
    return
  }

  const packs = await db.StickerSet.find({
    ownerTelegramId: data.ownerId,
    _id: { $ne: data.excludeSetId }
  })

  if (packs.length === 0) {
    return
  }

  const chunkSize = 70
  const formattedPacks = packs.map((pack) => {
    if (pack.name.toLowerCase().endsWith('fstikbot') && pack.public !== true) {
      if (
        ctx.from.id === data.ownerId ||
        ctx.from.id === ctx.config.mainAdminId ||
        ctx?.session?.userInfo?.adminRights?.includes('pack')
      ) {
        return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
      } else {
        return '<i>[hidden]</i>'
      }
    }
    return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
  })

  // Skip first 70 (already shown) and send the rest in chunks
  const remainingPacks = formattedPacks.slice(chunkSize)
  const chunks = []
  for (let i = 0; i < remainingPacks.length; i += chunkSize) {
    chunks.push(remainingPacks.slice(i, i + chunkSize))
  }

  for (const chunk of chunks) {
    await ctx.replyWithHTML(chunk.join(', '), { disable_web_page_preview: true })
  }
})
privateMessage.command('clear', (ctx) => ctx.scene.enter('photoClearSelect'))
privateMessage.action(/clear/, (ctx) => ctx.scene.enter('photoClearSelect'))
privateMessage.action(/catalog:publish:(.*)/, (ctx) => ctx.scene.enter('catalogPublish'))
privateMessage.action(/catalog:unpublish:(.*)/, (ctx) => ctx.scene.enter('catalogUnpublish'))

bot.command('lang', handleLanguage)
bot.action(/set_language:(.*)/, handleLanguage)

bot.command('error', ctx => ctx.replyWithHTML(error))

privateMessage.action(/delete_pack:(.*)/, async (ctx) => ctx.scene.enter('packDelete'))

bot.use(handleDonate)
privateMessage.use(handleBoostPack)
privateMessage.use(handleCoedit)

bot.use(handleInlineQuery)

bot.start(handleStart)
bot.on('new_chat_members', (ctx, next) => {
  if (ctx.message.new_chat_members.find((m) => m.id === ctx.botInfo.id)) {
    return handleStart(ctx, next)
  }
  return next()
})

// callback
privateMessage.action(/(set_pack):(.*)/, handlePacks)
privateMessage.action(/(hide_pack):(.*)/, handleHidePack)
privateMessage.action(/(rename_pack):(.*)/, (ctx) => ctx.scene.enter('packRename'))
privateMessage.action(/(delete_sticker):(.*)/, limitPublicPack, handleDeleteSticker)
privateMessage.action(/(restore_sticker):(.*)/, limitPublicPack, handleRestoreSticker)

bot.command('ss', handleSticker)

// sticker detect
privateMessage.on(['sticker', 'document', 'photo', 'video', 'video_note'], limitPublicPack, handleSticker)
privateMessage.on('message', (ctx, next) => {
  if (ctx.message && ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    return handleSticker(ctx)
  }
  return next()
})
privateMessage.action(/add_sticker/, handleSticker)


bot.use(privateMessage)

privateMessage.on('text', handleStickerUpade)
privateMessage.on('message', handleStart)

// start bot
db.connection.once('open', async () => {
  console.log('Connected to MongoDB')
  if (process.env.BOT_DOMAIN) {
    bot.launch({
      webhook: {
        domain: process.env.BOT_DOMAIN,
        hookPath: `/fStikBot:${process.env.BOT_TOKEN}`,
        port: process.env.WEBHOOK_PORT || 2500
      }
    }).then(() => {
      console.log('bot start webhook')
    })
  } else {
    bot.launch().then(() => {
      console.log('bot start polling')
    })
  }

  const locales = fs.readdirSync(path.resolve(__dirname, 'locales'));

  const enDescriptionLong = i18n.t('en', 'description.long');
  const enDescriptionShort = i18n.t('en', 'description.short');

  for (const locale of locales) {
    const localeName = locale.split('.')[0];

    const myName = await bot.telegram.callApi('getMyName', {
      language_code: localeName,
    });

    const name = i18n.t(localeName, 'name');

    if (myName.name !== name) {
      try {
        const response = await bot.telegram.callApi('setMyName', {
          name,
          language_code: localeName,
        });
        console.log('setMyName', localeName, response);
      } catch (error) {
        console.error('setMyName', localeName, error.description);
      }
    }

    const myDescription = await bot.telegram.callApi('getMyDescription', {
      language_code: localeName,
    });

    const descriptionLong = i18n.t(localeName, 'description.long');
    const newDescriptionLong = localeName === 'en' || descriptionLong !== enDescriptionLong
      ? descriptionLong.replace(/[\r\n]/gm, '')
      : '';

    if (newDescriptionLong !== myDescription.description.replace(/[\r\n]/gm, '')) {
      try {
        const description = newDescriptionLong ? i18n.t(localeName, 'description.long') : '';
        const response = await bot.telegram.callApi('setMyDescription', {
          description,
          language_code: localeName,
        });
        console.log('setMyDescription', localeName, response);
      } catch (error) {
        console.error('setMyDescription', localeName, error.description);
      }
    }

    const myShortDescription = await bot.telegram.callApi('getMyShortDescription', {
      language_code: localeName,
    });

    const descriptionShort = i18n.t(localeName, 'description.short');
    const newDescriptionShort = localeName === 'en' || descriptionShort !== enDescriptionShort
      ? descriptionShort.replace(/[\r\n]/gm, '')
      : '';

    if (newDescriptionShort !== myShortDescription.short_description.replace(/[\r\n]/gm, '')) {
      try {
        const shortDescription = newDescriptionShort ? i18n.t(localeName, 'description.short') : '';
        const response = await bot.telegram.callApi('setMyShortDescription', {
          short_description: shortDescription,
          language_code: localeName,
        });
        console.log('setMyShortDescription', localeName, response);
      } catch (error) {
        console.error('setMyShortDescription', localeName, error.description);
      }
    }

    const privateCommands = [
      { command: 'start', description: i18n.t(localeName, 'cmd.start.commands.start') },
      { command: 'packs', description: i18n.t(localeName, 'cmd.start.commands.packs') },
      { command: 'new', description: i18n.t(localeName, 'cmd.start.commands.new') },
      { command: 'catalog', description: i18n.t(localeName, 'cmd.start.commands.catalog') },
      { command: 'clear', description: i18n.t(localeName, 'cmd.start.commands.clear') },
      { command: 'about', description: i18n.t(localeName, 'cmd.start.commands.info') },
      { command: 'original', description: i18n.t(localeName, 'cmd.start.commands.original') },
      { command: 'delete', description: i18n.t(localeName, 'cmd.start.commands.delete') },
      { command: 'copy', description: i18n.t(localeName, 'cmd.start.commands.copy') },
      { command: 'publish', description: i18n.t(localeName, 'cmd.start.commands.publish') },
      { command: 'donate', description: i18n.t(localeName, 'cmd.start.commands.donate') },
      { command: 'lang', description: i18n.t(localeName, 'cmd.start.commands.lang') },
      { command: 'privacy', description: i18n.t(localeName, 'cmd.start.commands.privacy') },
    ]

    const myCommandsInPrivate = await bot.telegram.callApi('getMyCommands', {
      language_code: localeName,
      scope: JSON.stringify({
        type: 'all_private_chats'
      })
    })

    let needUpdatePrivate = false
    if (myCommandsInPrivate.length !== privateCommands.length) {
      needUpdatePrivate = true
    } else {
      for (let i = 0; i < privateCommands.length; i++) {
        const myCommand = myCommandsInPrivate.find(c => c.command === privateCommands[i].command)
        if (!myCommand || myCommand.description !== privateCommands[i].description) {
          needUpdatePrivate = true
          break
        }
      }
    }

    if (needUpdatePrivate) {
      await bot.telegram.callApi('setMyCommands', {
        commands: privateCommands,
        language_code: localeName,
        scope: JSON.stringify({
          type: 'all_private_chats'
        })
      })
    }

    const groupCommands = [
      { command: 'ss', description: i18n.t(localeName, 'cmd.start.commands.ss') },
      { command: 'packs', description: i18n.t(localeName, 'cmd.start.commands.packs') },
    ]

    const myCommandsInGroup = await bot.telegram.callApi('getMyCommands', {
      language_code: localeName,
      scope: JSON.stringify({
        type: 'all_group_chats'
      })
    })

    let needUpdateGroup = false
    if (myCommandsInGroup.length !== groupCommands.length) {
      needUpdateGroup = true
    } else {
      for (let i = 0; i < groupCommands.length; i++) {
        const myCommand = myCommandsInGroup.find(c => c.command === groupCommands[i].command)
        if (!myCommand || myCommand.description !== groupCommands[i].description) {
          needUpdateGroup = true
          break
        }
      }
    }

    if (needUpdateGroup) {
      await bot.telegram.callApi('setMyCommands', {
        commands: groupCommands,
        language_code: localeName,
        scope: JSON.stringify({
          type: 'all_group_chats'
        })
      })
    }
  }

  require('./utils/messaging')
  // require('./utils/optimize-db')

  setInterval(() => {
    updateMonitor()
  }, 1000 * 25) // every 25 seconds

  // Memory monitoring
  setInterval(() => {
    const usage = process.memoryUsage()
    if (usage.heapUsed > 2048 * 1024 * 1024) { // 2GB threshold
      console.log('High memory usage:', Math.round(usage.heapUsed / 1024 / 1024) + 'MB')
      if (global.gc) global.gc()
    }
  }, 1000 * 30) // every 30 seconds
})
