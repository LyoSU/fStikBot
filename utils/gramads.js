const got = require('got')

module.exports = async (chatId) => {
  const token = process.env.GRAMADS_TOKEN

  const headers = {
    Authorization: `bearer ${token}`,
    'Content-Type': 'application/json'
  }

  const sendPostDto = { SendToChatId: chatId }
  const response = await got.post('https://api.gramads.net/ad/SendPost', {
    headers,
    json: sendPostDto
  }).catch((err) => {
    return err
  })

  if (response.statusCode !== 200) {
    // something went wrong
    return
  }

  const result = response.body

  return result
}
