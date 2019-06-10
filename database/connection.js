const mongoose = require('mongoose')


const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  useNewUrlParser: true,
})

connection.then(() => {
  console.log('DB connected')
})

connection.catch((error) => {
  console.log('DB error', error)
})

module.exports = connection
