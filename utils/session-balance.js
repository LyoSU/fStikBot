// Mirror a balance read back from the database into the session user doc.
//
// Balances only change through atomic $inc. Assigning the result to the
// session doc marks `balance` modified, and persistUserIfDirty then $sets
// that value after the handler — wiping whatever changed in the database
// meanwhile (a payment, an admin /credit). Unmarking keeps the session
// display fresh without the save writing it.
const syncBalance = (user, balance) => {
  if (!user || typeof balance !== 'number') return
  user.balance = balance
  if (typeof user.unmarkModified === 'function') user.unmarkModified('balance')
}

module.exports = { syncBalance }
