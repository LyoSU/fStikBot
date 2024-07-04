const fs = require('fs')
const sharp = require('sharp')
const path = require('path')
const Telegraf = require('telegraf')
const Composer = require('telegraf/composer')
const session = require('telegraf/session')
const rateLimit = require('telegraf-ratelimit')
const I18n = require('telegraf-i18n')
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
  handleCopyPack,
  handleCoedit,
  handleLanguage,
  handleEmoji,
  handleAboutUser,
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
  downloadFileByURL
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

// use session
bot.use(
  session({
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
    ctx.session.userInfo.save()
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

const userAboutHelp = (ctx) => ctx.replyWithHTML(ctx.i18n.t('userAbout.help'), {
  reply_markup: {
    keyboard: [
      [{
        text: ctx.i18n.t('userAbout.select_user'),
        request_users: {
          request_id: 1,
          user_is_bot: false,
          max_quantity: 1,
        }
      }],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ],
    resize_keyboard: true
  }
})
privateMessage.action(/user_about/, userAboutHelp)
privateMessage.command('user_about', userAboutHelp)

privateMessage.command('paysupport', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.paysupport')))
privateMessage.command('privacy', (ctx) => ctx.replyWithHTML(fs.readFileSync(path.resolve(__dirname, 'privacy.html'), 'utf-8')))

privateMessage.hears(/(addstickers|addemoji|addemoji)\/(.*)/, handleRestorePack)

privateMessage.command('report', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.report')))
privateMessage.hears(/\/new/, (ctx) => ctx.scene.enter('newPack'))
privateMessage.action(/new_pack:(.*)/, (ctx) => ctx.scene.enter('newPack'))
privateMessage.hears(/(addstickers|addemoji|addemoji)\/(.*)/, handleCopyPack)
privateMessage.command('publish', (ctx) => ctx.scene.enter('catalogPublishNew'))
privateMessage.action(/publish/, (ctx) => ctx.scene.enter('catalogPublishNew'))
privateMessage.command('frame', (ctx) => ctx.scene.enter('packFrame'))
privateMessage.action(/frame/, (ctx) => ctx.scene.enter('packFrame'))
privateMessage.command('delete', (ctx) => ctx.scene.enter('deleteSticker'))
privateMessage.action(/^delete_sticker$/, (ctx) => ctx.scene.enter('deleteSticker'))
privateMessage.command('catalog', handleCatalog)
privateMessage.action(/catalog/, handleCatalog)
privateMessage.command('public', handleSelectPack)
privateMessage.command('emoji', handleEmoji)
privateMessage.command('copy', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.copy')))
privateMessage.command('restore', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.restore')))
privateMessage.command('original', (ctx) => ctx.scene.enter('originalSticker'))
privateMessage.action(/original/, (ctx) => ctx.scene.enter('originalSticker'))
privateMessage.command('about', (ctx) => ctx.scene.enter('packAbout'))
privateMessage.action(/about/, (ctx) => ctx.scene.enter('packAbout'))
privateMessage.command('search', (ctx) => ctx.scene.enter('searchStickerSet'))
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

privateMessage.use((ctx, next) => {
  if (ctx?.message?.users_shared) {
    return handleAboutUser(ctx)
  }
  return next()
})

bot.use(privateMessage)

privateMessage.on('forward', handleAboutUser)
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
      { command: 'copy', description: i18n.t(localeName, 'cmd.start.commands.copy') },
      { command: 'delete', description: i18n.t(localeName, 'cmd.start.commands.delete') },
      { command: 'original', description: i18n.t(localeName, 'cmd.start.commands.original') },
      { command: 'about', description: i18n.t(localeName, 'cmd.start.commands.about') },
      { command: 'user_about', description: i18n.t(localeName, 'cmd.start.commands.user_about') },
      { command: 'clear', description: i18n.t(localeName, 'cmd.start.commands.clear') },
      { command: 'catalog', description: i18n.t(localeName, 'cmd.start.commands.catalog') },
      { command: 'publish', description: i18n.t(localeName, 'cmd.start.commands.publish') },
      { command: 'lang', description: i18n.t(localeName, 'cmd.start.commands.lang') },
      { command: 'report', description: i18n.t(localeName, 'cmd.start.commands.report') },
      { command: 'donate', description: i18n.t(localeName, 'cmd.start.commands.donate') },
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
})
