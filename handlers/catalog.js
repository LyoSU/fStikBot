const { replyOrEditBanner } = require('../banners')

// /catalog, the "Catalog" button on /start and the "catalog" start payload.
module.exports = async (ctx) => {
  const caption = ctx.i18n.t(ctx.callbackQuery?.data === 'search_catalog' ? 'cmd.start.search_catalog' : 'cmd.start.catalog')

  await replyOrEditBanner(ctx, 'catalog', caption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: ctx.i18n.t('cmd.start.btn.catalog'), url: ctx.config.catalogUrl }],
        [{ text: ctx.i18n.t('cmd.start.btn.catalog_app'), url: ctx.config.catalogAppUrl }],
        [{ text: ctx.i18n.t('cmd.start.commands.publish'), callback_data: 'publish' }]
      ]
    }
  })
}
