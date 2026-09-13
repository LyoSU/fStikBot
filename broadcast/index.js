// Public surface for the broadcast subsystem.
//
// Wiring contract:
//   - bot.js calls startWorker() once at boot and awaits stopWorker() on shutdown.
//   - scenes/broadcast.js calls audiences.list() / audiences.get() for the
//     picker, and renderPreview() to show the captured post on confirm.
//   - handlers/admin/messaging.js uses cleanupRecipients() on cancel and
//     renderPreview() for the admin:messaging:view button.
//
// Everything else is internal to the directory.

const { start, stop } = require('./worker')
const audiences = require('./audiences')
const { cleanupRecipients } = require('./runner')
const { renderPreview } = require('./preview')
const { STATUS, isTerminal } = require('./status')

module.exports = {
  startWorker: start,
  stopWorker: stop,
  cleanupRecipients,
  renderPreview,
  audiences,
  STATUS,
  isTerminal
}
