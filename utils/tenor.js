const got = require('got')

const search = async (query, limit, pos) => {
  const response = await got.get(`https://g.tenor.com/v1/search?q=${query}&key=${process.env.TENOR_KEY}&limit=${limit}&pos=${pos}&searchfilter=sticker`, {
    timeout: {
      lookup: 100,
      connect: 50,
      secureConnect: 50,
      socket: 1000,
      send: 10000,
      response: 1000
    }
  })

  return JSON.parse(response.body)
}

const trending = async (pos, locale) => {
  const response = await got.get(`https://g.tenor.com/v1/trending?key=${process.env.TENOR_KEY}&locale=${locale}&limit=50${pos ? `&pos=${pos}` : ''}&searchfilter=sticker`, {
    timeout: {
      lookup: 100,
      connect: 50,
      secureConnect: 50,
      socket: 1000,
      send: 10000,
      response: 1000
    }
  })

  return JSON.parse(response.body)
}

module.exports = {
  search,
  trending
}
