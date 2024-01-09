const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from.is_bot) {
    return ctx.deleteMessage()
  }

  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.enter', {
    name: userName(ctx.from)
  }),
  Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new_emoji'), 'new_pack:custom_emoji')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.delete'), 'delete_sticker'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.original'), 'original')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.catalog'), 'catalog'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.publish'), 'publish')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.clear'), 'clear'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.about'), 'about')
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
