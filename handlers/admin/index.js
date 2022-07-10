const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const { match } = require('telegraf-i18n')

const composer = new Composer()

const checkAdminRight = (ctx, next) => {
  if (ctx.config.mainAdminId === ctx.from.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.length > 0)) return next()
  else return ctx.replyWithHTML(ctx.i18n.t('admin.not_allowed'))
}

const adminType = [
  'messaging',
  'pack'
]

const main = async (ctx, next) => {
  const resultText = ctx.i18n.t('admin.info')

  const inlineKeyboard = []
  adminType.forEach((type) => {
    if (ctx.config.mainAdminId === ctx.from.id || ctx.session.userInfo.adminRights.includes(type)) inlineKeyboard.push([Markup.callbackButton(ctx.i18n.t(`admin.menu.${type}`), `admin:${type}`)])
  })

  const replyMarkup = Markup.inlineKeyboard(inlineKeyboard)

  if (ctx.callbackQuery) {
    await ctx.editMessageText(resultText, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }).catch(() => {})
  } else {
    await ctx.replyWithHTML(resultText, {
      reply_markup: replyMarkup
    })
  }
}

const setPremium = async (ctx, next) => {
  const userId = ctx.match[1]

  let findUser

  findUser = await ctx.db.User.findOne({
    telegram_id: parseInt(userId) || 0
  })

  if (!findUser) {
    findUser = await ctx.db.User.findOne({
      username: userId
    })
  }

  if (!findUser) return ctx.replyWithHTML(ctx.i18n.t('admin.premium.user_not_found'))

  findUser.premium = !findUser.premium

  await findUser.save()

  return ctx.replyWithHTML(ctx.i18n.t('admin.premium.changed', {
    status: findUser.premium
  }))
}

adminType.forEach((type) => {
  composer.use(Composer.optional((ctx) => {
    return ctx.config.mainAdminId === ctx.from.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.includes(type))
  }, require(`./${type}`)))
})

composer.command('admin', checkAdminRight, main)
composer.hears(/\/premium (.*)/, checkAdminRight, setPremium)
composer.hears([match('start.menu.admin')], checkAdminRight, main)
composer.action(/admin:(.*)/, checkAdminRight, main)

module.exports = composer
