db.users.find(
  {
    updatedAt: {
      $gte: ISODate('2021-02-22')
    },
    locale: 'ru'
  }
)
