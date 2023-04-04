const fs = require('fs')
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
  handleStart,
  handleHelp,
  handleClub,
  handleSticker,
  handleDeleteSticker,
  handleRestoreSticker,
  handlePacks,
  handleSelectPack,
  handleHidePack,
  handleRestorePack,
  handleCatalog,
  handleCopyPack,
  handleCoedit,
  handleLanguage,
  handleEmoji,
  handleStickerUpade,
  handleInlineQuery
} = require('./handlers')
const scenes = require('./scenes')
const {
  updateUser,
  stats
} = require('./utils')

global.startDate = new Date()

// init bot
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    webhookReply: false
  },
  handlerTimeout: 500
})

bot.use((ctx, next) => {
  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('timeout'))
    }, 1000 * 3)
  })

  const nextPromise = next()

  return Promise.race([timeoutPromise, nextPromise])
    .catch((error) => {
      if (error.message === 'timeout') {
        console.error('timeout', ctx.update)
        return false
      }

      handleError(error, ctx)
      return true
    })
})


bot.on(['channel_post', 'edited_channel_post', 'poll'], () => {})

// I18n
const { match } = I18n
const i18n = new I18n({
  directory: path.resolve(__dirname, 'locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

bot.use(i18n)

// rate limit
bot.use(rateLimit({
  window: 1100,
  limit: 3,
  onLimitExceeded: (ctx) => ctx.reply(ctx.i18n.t('ratelimit'))
}))

const limitPublicPack = Composer.optional((ctx) => {
  return ctx?.session?.userInfo?.stickerSet?.passcode === 'public'
}, rateLimit({
  window: 1000 * 60,
  limit: 1,
  onLimitExceeded: (ctx) => ctx.reply(ctx.i18n.t('ratelimit'))
}))

bot.use(stats)

bot.use((ctx, next) => {
  if (ctx.update.my_chat_member) return false
  else return next()
})

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
    if (ctx.inlineQuery) return ctx.answerInlineQuery(...ctx.state.answerIQ)
    if (ctx.callbackQuery) return ctx.answerCbQuery(...ctx.state.answerCbQuery)
  })
})

bot.use(Composer.privateChat(async (ctx, next) => {
  await updateUser(ctx)
  await next(ctx)
  await ctx.session.userInfo.save().catch(() => {})
}))

bot.command('json', ({ replyWithHTML, message }) =>
  replyWithHTML('<code>' + JSON.stringify(message, null, 2) + '</code>')
)

// scene
bot.use(scenes)

bot.use(require('./handlers/admin'))

// main commands
bot.start((ctx, next) => {
  if (ctx.startPayload === 'inline_pack') {
    ctx.state.type = 'inline'
    return handlePacks(ctx)
  }
  return next()
})
bot.command('help', handleHelp)
bot.command('packs', handlePacks)
bot.action(/packs:(type):(.*)/, handlePacks)
bot.action(/packs:(.*)/, handlePacks)

bot.start((ctx, next) => {
  if (ctx.startPayload.match(/s_(.*)/)) return handleSelectPack(ctx)
  return next()
})

bot.hears(/\/new/, (ctx) => ctx.scene.enter('newPack'))
bot.action(/new_pack:(.*)/, (ctx) => ctx.scene.enter('newPack'))
bot.hears(['/donate', '/club', '/start club', match('cmd.start.btn.club')], handleClub)
bot.hears(/addstickers\/(.*)/, handleCopyPack)
bot.command('publish', (ctx) => ctx.scene.enter('catalogPublishNew'))
bot.command('frame', (ctx) => ctx.scene.enter('packFrame'))
bot.command('delete', (ctx) => ctx.scene.enter('deleteSticker'))
bot.command('catalog', handleCatalog)
bot.command('public', handleSelectPack)
bot.command('emoji', handleEmoji)
bot.command('copy', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.copy')))
bot.command('restore', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.restore')))
bot.command('original', (ctx) => ctx.scene.enter('originalSticker'))
bot.command('about', (ctx) => ctx.scene.enter('packAbout'))
bot.command('search', (ctx) => ctx.scene.enter('searchStickerSet'))
bot.action(/catalog:publish:(.*)/, (ctx) => ctx.scene.enter('catalogPublish'))
bot.command('lang', handleLanguage)
bot.command('error', ctx => ctx.replyWithHTML(error))

bot.action(/delete_pack:(.*)/, async (ctx) => ctx.scene.enter('packDelete'))

bot.use(handleCoedit)
bot.use(handleInlineQuery)

// sticker detect
bot.on(['sticker', 'document', 'photo', 'video', 'video_note'], limitPublicPack, handleSticker)
bot.on('message', (ctx, next) => {
  if (ctx.message && ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    return handleSticker(ctx)
  }
  return next()
})

// callback
bot.action(/(set_pack):(.*)/, handlePacks)
bot.action(/(hide_pack):(.*)/, handleHidePack)
bot.action(/(rename_pack):(.*)/, (ctx) => ctx.scene.enter('packRename'))
bot.action(/(delete_sticker):(.*)/, limitPublicPack, handleDeleteSticker)
bot.action(/(restore_sticker):(.*)/, limitPublicPack, handleRestoreSticker)
bot.action(/set_language:(.*)/, handleLanguage)

// forward from sticker bot
bot.on('text', (ctx, next) => {
  if (ctx.message.forward_from && ctx.message.forward_from.id === 429000) return handleRestorePack(ctx)
  else return next()
})

bot.on('text', handleStickerUpade)

// club
bot.action(/(club):(.*)/, handleClub)

// any message
bot.on('message', handleStart)

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
        const description = newDescriptionShort ? i18n.t(localeName, 'description.short') : '';
        const response = await bot.telegram.callApi('setMyShortDescription', {
          description,
          language_code: localeName,
        });
        console.log('setMyShortDescription', localeName, response);
      } catch (error) {
        console.error('setMyShortDescription', localeName, error.description);
      }
    }

    const commands = [
      { command: 'start', description: i18n.t(localeName, 'cmd.start.commands.start') },
      { command: 'packs', description: i18n.t(localeName, 'cmd.start.commands.packs') },
      { command: 'delete', description: i18n.t(localeName, 'cmd.start.commands.delete') },
      { command: 'catalog', description: i18n.t(localeName, 'cmd.start.commands.catalog') },
      { command: 'publish', description: i18n.t(localeName, 'cmd.start.commands.publish') },
      { command: 'lang', description: i18n.t(localeName, 'cmd.start.commands.lang') },
      { command: 'donate', description: i18n.t(localeName, 'cmd.start.commands.donate') }
    ]

    const myCommands = await bot.telegram.callApi('getMyCommands', {
      language_code: localeName,
      scope: JSON.stringify({
        type: 'all_private_chats'
      })
    })

    let needUpdate = false
    if (myCommands.length !== commands.length) {
      needUpdate = true
    } else {
      for (let i = 0; i < commands.length; i++) {
        const myCommand = myCommands.find(c => c.command === commands[i].command)
        if (!myCommand || myCommand.description !== commands[i].description) {
          needUpdate = true
          break
        }
      }
    }

    if (needUpdate) {
      await bot.telegram.callApi('setMyCommands', {
        commands,
        language_code: localeName,
        scope: JSON.stringify({
          type: 'all_private_chats'
        })
      })
    }
  }


  require('./utils/messaging')
  // require('./utils/optimize-db')
})
