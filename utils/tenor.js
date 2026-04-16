const got = require('got')

const search = async (query, limit, pos) => {
  const response = await got.get(`https://g.tenor.com/v1/search?q=${query}&key=${process.env.TENOR_KEY}&limit=${limit}&pos=${pos}&searchfilter=sticker`, {
    timeout: {
      lookup: 1000,
      connect: 1000,
      secureConnect: 1000,
      socket: 10000,
      send: 10000,
      response: 8000
    }
  })

  return JSON.parse(response.body)
}

const trending = async (pos, locale) => {
  const response = await got.get(`https://g.tenor.com/v1/trending?key=${process.env.TENOR_KEY}&locale=${locale}&limit=50${pos ? `&pos=${pos}` : ''}&searchfilter=sticker`, {
    timeout: {
      lookup: 1000,
      connect: 1000,
      secureConnect: 1000,
      socket: 10000,
      send: 10000,
      response: 8000
    }
  })

  return JSON.parse(response.body)
}

module.exports = {
  search,
  trending
}
