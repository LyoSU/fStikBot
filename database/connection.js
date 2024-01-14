const mongoose = require('mongoose')

const connection = mongoose.createConnection(process.env.MONGODB_URI)

connection.on('error', error => {
  console.error(error)
  process.exit(1)
})

const atlasConnection = mongoose.createConnection(process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI, {
  poolSize: 10,
  maxTimeMS: 3,
  useUnifiedTopology: true,
  useNewUrlParser: true
})

atlasConnection.on('error', error => {
  console.error(error)
  process.exit(1)
})

module.exports = {
  connection,
  atlasConnection
}
