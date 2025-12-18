const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from.is_bot) {
    return ctx.deleteMessage()
  }

  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.start.group', {
      groupTitle: ctx.chat.title
    }), {
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_group_pack'), 'select_group_pack')
        ]
      ])
    })
  }

  const countStickerSets = await ctx.db.StickerSet.countDocuments({
    owner: ctx.session.userInfo.id
  })

  const isNewUser = countStickerSets <= 0

  const keyboard = []

  // Adaptive menu based on user experience
  if (isNewUser) {
    // For new users - focus on creating
    keyboard.push([
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')
    ])
  } else {
    // For experienced users - focus on managing packs
    keyboard.push([
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null')
    ])
  }

  // Common buttons for everyone
  keyboard.push(
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.search_catalog'), 'search_catalog')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.guide'), 'guide:menu')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.clear'), 'clear')
    ],
    [
      Markup.urlButton(ctx.i18n.t('cmd.start.commands.add_to_group'), `https://t.me/${ctx.botInfo.username}?startgroup=bot`)
    ]
  )

  // Build message text with optional advertising
  let messageText = ctx.i18n.t('cmd.start.enter', {
    name: userName(ctx.from)
  })

  if (ctx.config?.advertising?.text && ctx.config?.advertising?.link) {
    messageText += `\n\n<a href="${ctx.config.advertising.link}">${ctx.config.advertising.text}</a>`
  }

  await ctx.replyWithHTML(messageText, Markup.inlineKeyboard(keyboard).extra())

  if (ctx.config.catalogUrl && ctx.startPayload === 'catalog') {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.start.catalog'), {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: ctx.i18n.t('cmd.start.btn.catalog'),
              url: ctx.config.catalogUrl
            }
          ],
          [
            {
              text: ctx.i18n.t('cmd.start.btn.catalog_app'),
              url: ctx.config.catalogAppUrl
            }
          ]
          // [
          //   {
          //     text: ctx.i18n.t('cmd.start.btn.catalog_browser'),
          //     login_url: {
          //       url: ctx.config.catalogUrl,
          //       request_write_access: true
          //     }
          //   }
          // ]
        ]
      })
    })
  }

  ctx.telegram.callApi('deleteMyCommands', {
    scope: {
      type: 'chat',
      chat_id: ctx.chat.id
    }
  }).catch(() => {})
}
