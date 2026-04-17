const { editBanner, sendBanner } = require('../banners')

module.exports = async (ctx) => {
  const caption = ctx.i18n.t('cmd.start.search_catalog')
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

  // From /start callback → swap welcome banner to catalog banner in place.
  // From a standalone trigger → send fresh.
  if (ctx.callbackQuery) {
    await editBanner(ctx, 'catalog', caption, extra)
  } else {
    await sendBanner(ctx, 'catalog', caption, extra)
  }
}
