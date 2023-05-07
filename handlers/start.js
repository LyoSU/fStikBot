const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from.is_bot) {
    return ctx.deleteMessage()
  }

  ctx.telegram.callApi('deleteMyCommands', {
    scope: {
      type: 'chat',
      chat_id: ctx.chat.id
    }
  }).catch(() => {})

  const chat = await ctx.getChat()

  if (!chat?.pinned_message && ctx.config.catalogAppUrl) {
    const pinMessage = await ctx.replyWithHTML('⁠&#8288;', {
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            // {
            //   text: ctx.i18n.t('cmd.start.btn.catalog_mini'),
            //   web_app: {
            //     url: ctx.config.catalogUrl,
            //     request_write_access: true
            //   }
            // },
            {
              text: ctx.i18n.t('cmd.start.btn.catalog_app_mini'),
              url: ctx.config.catalogAppUrl
            }
          ]
          // [
          //   {
          //     text: ctx.i18n.t('cmd.start.btn.catalog_browser_mini'),
          //     login_url: {
          //       url: ctx.config.catalogUrl,
          //       request_write_access: true
          //     }
          //   }
          // ]
        ]
      })
    })

    await ctx.unpinAllChatMessages().catch(() => {})

    await ctx.pinChatMessage(pinMessage.message_id, {
      disable_notification: true
    })
  }

  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.enter', {
    name: userName(ctx.from)
  }),
  Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null'),
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new'), 'new_pack:null'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.new_emoji'), 'new_pack:custom_emoji'),
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.catalog'), 'catalog'),
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.publish'), 'publish'),
    ],
    [
      Markup.callbackButton(ctx.i18n.t('cmd.start.commands.clear'), 'clear'),
    ],
    [
      Markup.callbackButton('🌐 Change language', 'set_language:null'),
    ]
  ]).extra())

  if (ctx.config.catalogUrl && ctx.startPayload === 'catalog') {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.start.catalog'), {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: ctx.i18n.t('cmd.start.btn.catalog'),
              web_app: {
                url: ctx.config.catalogUrl,
                request_write_access: true
              }
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
}
