require('dotenv').config({ path: './.env' })
require('./bot')

process.on('unhandledRejection', (res, promise) => {
  console.log(res, promise)
})
