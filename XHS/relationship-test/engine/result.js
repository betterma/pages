/**
 * 结果引擎：分数 → 关系画像（规则 + 模板，无 AI）
 */

/**
 * @param {object} config
 * @param {object} scores
 * @returns {{ typeId: string, title: string, scores: object }}
 */
function buildResult(config, scores) {
  var types = config.resultTypes || []
  var matched = null
  var i
  for (i = 0; i < types.length; i++) {
    if (types[i].rule && types[i].rule(scores)) {
      matched = types[i]
      break
    }
  }

  if (!matched) {
    matched = {
      id: 'unknown',
      title: '待完善画像'
    }
  }

  return {
    typeId: matched.id,
    title: matched.title,
    scores: scores
  }
}

module.exports = {
  buildResult: buildResult
}
