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

  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.enter', {
    name: userName(ctx.from)
  }),
  Markup.inlineKeyboard([
    [
      Markup.urlButton(ctx?.config?.ruAdvertising?.text, ctx?.config?.ruAdvertising?.link, ctx.i18n.locale() !== 'ru' || !ctx?.config?.ruAdvertising?.text)
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null', countStickerSets <= 0),
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.delete'), 'delete_sticker', countStickerSets <= 0),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.original'), 'original')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.catalog'), 'catalog'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.publish'), 'publish')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.clear'), 'clear')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.about'), 'about'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.user_about'), 'user_about')
    ],
    [
      Markup.urlButton(ctx.i18n.t('cmd.start.commands.add_to_group'), `https://t.me/${ctx.botInfo.username}?startgroup=bot`)
    ]
  ]).extra())

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
