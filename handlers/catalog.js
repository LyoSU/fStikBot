const { replyOrEditBanner } = require('../banners')

module.exports = async (ctx) => {
  const caption = ctx.i18n.t('cmd.start.catalog')
  const extra = {
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
        ],
        [
          {
            text: ctx.i18n.t('cmd.start.commands.publish'),
            callback_data: 'publish'
          }
        ]
      ]
    })
  }

  await replyOrEditBanner(ctx, 'catalog', caption, extra)
}
