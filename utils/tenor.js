const got = require('got')

module.exports = async (query, pos) => {
  const response = await got.get(`https://g.tenor.com/v1/search?q=${query}&key=${process.env.TENOR_KEY}&limit=25&pos=${pos}&searchfilter=sticker`)

  return JSON.parse(response.body)
}
