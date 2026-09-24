var STORAGE_PREFIX = 'entitlement:'

function keyOf(testId) {
  return STORAGE_PREFIX + testId
}

function getEntitlement(testId) {
  try {
    return xhs.getStorageSync(keyOf(testId)) || null
  } catch (e) {
    return null
  }
}

function setEntitlement(testId, data) {
  xhs.setStorageSync(keyOf(testId), data)
}

function isPurchased(testId) {
  var data = getEntitlement(testId)
  return !!(data && data.purchased)
}

function markPurchased(testId, extra) {
  var payload = {
    testId: testId,
    purchased: true,
    orderId: (extra && extra.orderId) || ('mock_' + Date.now()),
    paidAt: (extra && extra.paidAt) || Date.now(),
    amountFen: (extra && extra.amountFen) || 0
  }
  setEntitlement(testId, payload)
  return payload
}

function clearEntitlement(testId) {
  try {
    xhs.removeStorageSync(keyOf(testId))
  } catch (e) {
    // ignore
  }
}

module.exports = {
  getEntitlement: getEntitlement,
  setEntitlement: setEntitlement,
  isPurchased: isPurchased,
  markPurchased: markPurchased,
  clearEntitlement: clearEntitlement
}
