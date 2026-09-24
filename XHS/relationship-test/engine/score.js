/**
 * 评分引擎：答案 → 各维度 0～100 分
 * 不含 AI，结果可重复。
 */

function optionValue(question, answerKey) {
  const option = (question.options || []).find(function (item) {
    return item.key === answerKey
  })
  if (!option) return null
  var value = option.value
  if (question.reverse) {
    value = 5 - value
  }
  return value
}

function normalize(sum, count) {
  if (!count) return 0
  // value 范围 1～4 → 标准化到 0～100
  var score = ((sum - count * 1) / (count * 3)) * 100
  return Math.round(Math.max(0, Math.min(100, score)))
}

/**
 * @param {object} config 测试配置
 * @param {object} answers { [questionId]: 'A'|'B'|'C'|'D' }
 * @returns {object} 维度分数字典
 */
function score(config, answers) {
  var buckets = {}
  var counts = {}
  var dimensions = config.dimensions || []
  var i

  for (i = 0; i < dimensions.length; i++) {
    buckets[dimensions[i].key] = 0
    counts[dimensions[i].key] = 0
  }

  var questions = config.questions || []
  for (i = 0; i < questions.length; i++) {
    var q = questions[i]
    var answerKey = answers[q.id] || answers[String(q.id)]
    if (!answerKey) continue
    var value = optionValue(q, answerKey)
    if (value == null) continue
    if (!(q.dimension in buckets)) {
      buckets[q.dimension] = 0
      counts[q.dimension] = 0
    }
    buckets[q.dimension] += value
    counts[q.dimension] += 1
  }

  var result = {}
  var keys = Object.keys(buckets)
  for (i = 0; i < keys.length; i++) {
    var key = keys[i]
    if (counts[key] > 0) {
      result[key] = normalize(buckets[key], counts[key])
    }
  }
  return result
}

module.exports = {
  score: score,
  optionValue: optionValue,
  normalize: normalize
}
