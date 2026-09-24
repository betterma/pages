var STORAGE_PREFIX = 'progress:'

function keyOf(testId) {
  return STORAGE_PREFIX + testId
}

function getProgress(testId) {
  try {
    return xhs.getStorageSync(keyOf(testId)) || null
  } catch (e) {
    return null
  }
}

function saveProgress(testId, progress) {
  var payload = {
    testId: testId,
    currentIndex: progress.currentIndex || 0,
    answers: progress.answers || {},
    updatedAt: Date.now()
  }
  xhs.setStorageSync(keyOf(testId), payload)
  return payload
}

function clearProgress(testId) {
  try {
    xhs.removeStorageSync(keyOf(testId))
  } catch (e) {
    // ignore
  }
}

function answeredCount(progress) {
  if (!progress || !progress.answers) return 0
  return Object.keys(progress.answers).length
}

module.exports = {
  getProgress: getProgress,
  saveProgress: saveProgress,
  clearProgress: clearProgress,
  answeredCount: answeredCount
}
