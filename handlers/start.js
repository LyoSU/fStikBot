const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  if (ctx.chat.type === 'private' && ctx.from.is_bot) {
    return ctx.deleteMessage()
  }

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

    await ctx.pinChatMessage(pinMessage.message_id, {
      disable_notification: true
    })
  }

  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.info', {
    name: userName(ctx.from)
  }), Markup.removeKeyboard().extra({ disable_web_page_preview: true }))

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
