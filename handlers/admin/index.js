const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')

const i18n = new I18n({
  directory: `${__dirname}/../../locales`,
  defaultLanguage: 'en',
  sessionName: 'session',
  useSession: true,
  allowMissing: false,
  skipPluralize: true
})

const composer = new Composer()

const checkAdminRight = (ctx, next) => {
  if (ctx.config.mainAdminId === ctx.from.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.length > 0)) return next()
  else return ctx.replyWithHTML('You are not admin')
}

const adminType = [
  'messaging',
  'pack'
]

const main = async (ctx, next) => {
  const resultText = 'Admin panel'

  const inlineKeyboard = []
  adminType.forEach((type) => {
    if (ctx.config.mainAdminId === ctx.from.id || ctx.session.userInfo.adminRights.includes(type)) inlineKeyboard.push([Markup.callbackButton(`Admin ${type}`, `admin:${type}`)])
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
  const credit = parseInt(ctx.match[2])

  let findUser

  findUser = await ctx.db.User.findOne({
    telegram_id: parseInt(userId) || 0
  })

  if (!findUser) {
    findUser = await ctx.db.User.findOne({
      username: userId
    })
  }

  if (!findUser) return ctx.replyWithHTML('User not found')

  findUser.balance += credit

  await findUser.save()

  await ctx.replyWithHTML(`User ${findUser.telegram_id} (${findUser.username}) balance updated to ${findUser.balance} credit (added ${credit} credit)`)

  if (credit !== 0) {
    await ctx.telegram.sendMessage(findUser.telegram_id, i18n.t(findUser.locale, 'donate.update', {
      amount: credit,
      balance: findUser.balance
    }), {
      parse_mode: 'HTML'
    })
  }
}

adminType.forEach((type) => {
  composer.use(Composer.optional((ctx) => {
    return ctx.config.mainAdminId === ctx?.from?.id || (ctx.session.userInfo.adminRights && ctx.session.userInfo.adminRights.includes(type))
  }, require(`./${type}`)))
})

composer.command('admin', checkAdminRight, main)
composer.hears(/\/credit (.*?) (-?\d+)/, checkAdminRight, setPremium)
composer.hears([I18n.match('start.menu.admin')], checkAdminRight, main)
composer.action(/admin:(.*)/, checkAdminRight, main)

module.exports = composer
