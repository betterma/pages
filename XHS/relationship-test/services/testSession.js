var progressStore = require('../storage/progress')
var scoreEngine = require('../engine/score')
var resultEngine = require('../engine/result')

function getSession(testId) {
  return progressStore.getProgress(testId)
}

function startFresh(testId) {
  progressStore.clearProgress(testId)
  return progressStore.saveProgress(testId, {
    currentIndex: 0,
    answers: {}
  })
}

function saveAnswer(testId, questionId, answerKey, currentIndex) {
  var session = progressStore.getProgress(testId) || {
    currentIndex: 0,
    answers: {}
  }
  var answers = session.answers || {}
  answers[String(questionId)] = answerKey
  return progressStore.saveProgress(testId, {
    currentIndex: typeof currentIndex === 'number' ? currentIndex : session.currentIndex,
    answers: answers
  })
}

function updateIndex(testId, currentIndex) {
  var session = progressStore.getProgress(testId) || {
    currentIndex: 0,
    answers: {}
  }
  return progressStore.saveProgress(testId, {
    currentIndex: currentIndex,
    answers: session.answers || {}
  })
}

/**
 * 提交：评分 → 生成结果 → 清除本地答案
 */
function submit(config) {
  var session = progressStore.getProgress(config.id)
  var answers = (session && session.answers) || {}
  var scores = scoreEngine.score(config, answers)
  var result = resultEngine.buildResult(config, scores)
  progressStore.clearProgress(config.id)
  return result
}

function clear(testId) {
  progressStore.clearProgress(testId)
}

function hasProgress(testId) {
  var session = progressStore.getProgress(testId)
  return !!(session && session.answers && Object.keys(session.answers).length > 0)
}

module.exports = {
  getSession: getSession,
  startFresh: startFresh,
  saveAnswer: saveAnswer,
  updateIndex: updateIndex,
  submit: submit,
  clear: clear,
  hasProgress: hasProgress
}
