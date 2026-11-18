// The bot's translations, loaded and compiled once. telegraf-i18n reads and
// compiles every locale file per instance, and six modules each built their
// own with these same options.
//
// Two keep their own on purpose: the catalog (scenes/pack-catalog.js) falls
// back to Russian, and the admin panel (handlers/admin) reads the session's
// locale and wants missing keys loud.
const path = require('path')
const I18n = require('telegraf-i18n')

module.exports = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})
