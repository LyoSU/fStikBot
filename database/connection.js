const mongoose = require('mongoose')

const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  useUnifiedTopology: true,
  useNewUrlParser: true
})

connection.on('error', error => {
  console.error(error)
})

module.exports = connection
