const mongoose = require('mongoose')


const stickersSchema = mongoose.Schema({
  file_id: {
    type: String,
    index: true,
    unique: true,
    required: true,
  },
}, {
  timestamps: true,
})


module.exports = stickersSchema
