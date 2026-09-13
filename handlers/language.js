const fs = require('fs')
const path = require('path')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const handleStart = require('./start')
const { sendBanner } = require('../banners')

const LOCALES_DIR = path.resolve(__dirname, '../locales')

const i18n = new I18n({
  directory: LOCALES_DIR,
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

// Built once: locale code → its own display name. A locale whose
// `language_name` falls back to the default one is treated as untranslated
// and left out of the picker.
const locales = {}
for (const fileName of fs.readdirSync(LOCALES_DIR)) {
  const localName = fileName.split('.')[0]
  if (localName === 'en' || i18n.t('en', 'language_name') !== i18n.t(localName, 'language_name')) {
    locales[localName] = { flag: i18n.t(localName, 'language_name') }
  }
}

module.exports = async (ctx) => {
  if (ctx.updateType === 'callback_query' && ctx.match[1] !== 'null') {
    if (locales[ctx.match[1]]) {
      await ctx.answerCbQuery(locales[ctx.match[1]].flag)

      ctx.session.userInfo.locale = ctx.match[1]
      ctx.session.userInfo.localeChosen = true
      ctx.i18n.locale(ctx.match[1])
      await handleStart(ctx)
    }
  } else {
    const button = []

    Object.keys(locales).forEach((key) => {
      button.push(Markup.callbackButton(locales[key].flag, `set_language:${key}`))
    })

    await sendBanner(ctx, 'language', ctx.i18n.t('cmd.lang.choose'), {
      reply_markup: Markup.inlineKeyboard(button, { columns: 2 })
    })
  }
}
