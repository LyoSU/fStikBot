const { messaging } = require('../utils')

module.exports = async (ctx) => {
  messaging(ctx.db.User.find(), 'test', {
    parse_mode: 'HTML'
  })
}
