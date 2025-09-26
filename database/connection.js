const mongoose = require('mongoose')

const connection = mongoose.createConnection(process.env.MONGODB_URI, {
  maxPoolSize: 50,
  maxTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxIdleTimeMS: 30000,
  useNewUrlParser: true,

  useUnifiedTopology: true
})

connection.on('error', error => {
  console.error(error)
  process.exit(1)
})

const atlasConnection = mongoose.createConnection(process.env.ATLAS_MONGODB_URI || process.env.MONGODB_URI, {
  maxPoolSize: 50,
  maxTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxIdleTimeMS: 30000,
  useNewUrlParser: true,
  useUnifiedTopology: true
})

atlasConnection.on('error', error => {
  console.error(error)
  process.exit(1)
})

module.exports = {
  connection,
  atlasConnection
}
