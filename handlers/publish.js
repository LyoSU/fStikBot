const Composer = require('telegraf/composer')

const composer = new Composer()

composer.command('publish', async ctx => {
  await ctx.replyWithHTML(ctx.i18n.t('catalog.publish.info'))
  await ctx.replyWithHTML(ctx.i18n.t('catalog.publish.description'))
})

module.exports = composer
