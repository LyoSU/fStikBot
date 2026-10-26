// The bot's errors as one JSON line each, for the log shipper (Vector →
// VictoriaLogs), shaped like the API's: level, kind, release, fp, where,
// message, stack and a little safe context. Never user ids, usernames,
// message text, file ids, pack names or tokens.
//
// Errors the world causes (a blocked bot, a message that was not modified, a
// callback answered too late) are warnings with their Telegram code, not
// errors: nothing in our code to fix.
const { scrub, fingerprint } = require('./fingerprint')
const { isExpectedNoise } = require('./expected-noise')

const USER_CAUSED = /message is not modified|query is too old|query ID is invalid|message to edit not found|message to delete not found|message can't be (?:edited|deleted)|MESSAGE_ID_INVALID/i

// The commit Coolify deployed, or the one an image was built with.
const release = () => String(process.env.SOURCE_COMMIT || process.env.RELEASE || 'dev').slice(0, 12)

// Beyond scrub: pack names (name_by_bot) and anything as long as a Telegram id.
const clean = (text, size) => scrub(text)
  .replace(/\b\w+_by_\w+\b/gi, '<pack>')
  .replace(/\b\d{6,}\b/g, '<id>')
  .slice(0, size)

const telegramCode = (error) => {
  const code = error?.code ?? error?.response?.error_code
  return Number.isInteger(code) ? code : undefined
}

const telegramDescription = (error) => {
  const description = error?.description || error?.response?.description
  return description ? clean(description, 200) : undefined
}

function isUserCaused (error) {
  return isExpectedNoise(error) || USER_CAUSED.test(error?.description || error?.response?.description || '')
}

// Only the shape of the update: what kind, which command or button family,
// which scene, which chat type. A command is its name, a callback its prefix.
function contextOf (ctx) {
  if (!ctx) return {}
  const text = ctx.message?.text
  const command = typeof text === 'string' && text.startsWith('/')
    ? (text.slice(1).split(/[\s@]/)[0].match(/^[a-z0-9_]{1,32}/i) || [])[0]
    : undefined
  const data = ctx.callbackQuery?.data
  const handler = typeof data === 'string' ? (data.match(/^[a-z_]{1,32}/i) || [])[0] : undefined

  return {
    updateType: ctx.updateType,
    command,
    handler,
    scene: ctx.scene?.current?.id,
    chatType: ctx.chat?.type
  }
}

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ''))

/**
 * One line. `level` defaults to 'warn' for user-caused Telegram errors and
 * 'error' otherwise; `fields` adds kind-specific safe fields.
 */
function errorLine (error, { kind = 'bot_error', where, level, context, fields } = {}) {
  const message = clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? ''), 500)
  const stack = error?.stack ? clean(error.stack, 2000) : undefined

  return JSON.stringify(compact({
    level: level || (isUserCaused(error) ? 'warn' : 'error'),
    kind,
    release: release(),
    fp: fingerprint(where, message, stack),
    where,
    message,
    stack,
    tgCode: telegramCode(error),
    tgDescription: telegramDescription(error),
    ...fields,
    context: context && Object.keys(compact(context)).length ? compact(context) : undefined
  }))
}

function logError (error, options) {
  const line = errorLine(error, options)
  if (line.startsWith('{"level":"warn"')) console.warn(line)
  else console.error(line)
}

module.exports = { errorLine, logError, contextOf, isUserCaused, release, clean }
