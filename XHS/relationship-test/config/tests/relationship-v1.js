/**
 * 关系状态测评 V1 — 正式 30 题配置
 *
 * 统一选项：几乎不会 / 偶尔会 / 经常会 / 几乎总是
 * 正向：A=1 B=2 C=3 D=4
 * 反向：由 engine/score.js 按 reverse 翻转
 *
 * 答题页不要展示维度名，避免用户迎合选项。
 */

var SHARED_OPTIONS = [
  { key: 'A', text: '几乎不会', value: 1 },
  { key: 'B', text: '偶尔会', value: 2 },
  { key: 'C', text: '经常会', value: 3 },
  { key: 'D', text: '几乎总是', value: 4 }
]

function q(id, dimension, reverse, stem) {
  return {
    id: id,
    dimension: dimension,
    reverse: reverse,
    stem: stem,
    options: SHARED_OPTIONS
  }
}

const relationshipV1 = {
  id: 'relationship-v1',
  title: '你们的关系到底是什么状态？',
  subtitle: '30道题，看看你在关系中的真实状态。',
  priceFen: 190,
  answerPrompt: '请选择最符合你平时状态的一项',
  dimensions: [
    { key: 'emotionalInvestment', label: '情感投入' },
    { key: 'security', label: '安全感' },
    { key: 'dependency', label: '依赖程度' },
    { key: 'communication', label: '沟通模式' },
    { key: 'boundary', label: '边界感' },
    { key: 'conflictSensitivity', label: '冲突敏感度' }
  ],
  questions: [
    // ① 情感投入 1–5
    q(1, 'emotionalInvestment', false, '当你真正喜欢一个人之后，你会不自觉地关注对方最近的状态。'),
    q(2, 'emotionalInvestment', false, '即使最近自己的事情很多，你也会愿意抽时间经营这段关系。'),
    q(3, 'emotionalInvestment', false, '对方遇到重要的事情时，你会很想知道事情最后怎么样了。'),
    q(4, 'emotionalInvestment', true, '你很少会因为一段关系的变化，而明显影响自己的情绪。'),
    q(5, 'emotionalInvestment', false, '你会记得对方曾经随口提过的一些小事，并在之后偶尔想起来。'),

    // ② 安全感 6–10
    q(6, 'security', false, '对方一段时间没有回复你的消息时，你通常不会马上往坏处想。'),
    q(7, 'security', false, '即使两个人暂时发生矛盾，你仍然相信这段关系不会轻易结束。'),
    q(8, 'security', false, '你不太需要对方频繁表达爱意，才能确认自己在这段关系中的位置。'),
    q(9, 'security', true, '当对方突然变得冷淡时，你很容易怀疑是不是自己做错了什么。'),
    q(10, 'security', true, '有时候即使没有发生什么具体的事情，你也会担心对方是不是正在慢慢离开自己。'),

    // ③ 依赖程度 11–15
    q(11, 'dependency', false, '遇到重要的事情时，你会非常希望对方能够陪着自己一起面对。'),
    q(12, 'dependency', false, '当自己心情不好的时候，第一个想到的往往是找对方。'),
    q(13, 'dependency', false, '如果对方长时间不在身边，你有时会明显觉得生活少了些什么。'),
    q(14, 'dependency', true, '即使对方不在身边，你也能很自然地安排自己的生活。'),
    q(15, 'dependency', true, '你有自己的兴趣、朋友和生活节奏，不会把大部分注意力都放在对方身上。'),

    // ④ 沟通模式 16–20
    q(16, 'communication', false, '两个人产生分歧时，你通常愿意直接把自己的想法说出来。'),
    q(17, 'communication', false, '当你觉得委屈时，你能够比较清楚地告诉对方自己为什么难受。'),
    q(18, 'communication', false, '即使你不同意对方的想法，你也愿意先听完对方为什么这么想。'),
    q(19, 'communication', true, '发生矛盾后，你有时会选择什么都不说，等对方自己发现你的情绪。'),
    q(20, 'communication', true, '当你不满意对方的行为时，你有时会故意变得冷淡，让对方意识到自己做错了。'),

    // ⑤ 边界感 21–25
    q(21, 'boundary', false, '即使两个人关系非常亲密，你也认为彼此应该拥有属于自己的私人空间。'),
    q(22, 'boundary', false, '你可以接受对方有一些不愿意与你分享的私人事情。'),
    q(23, 'boundary', false, '当对方提出一个让你明显不舒服的要求时，你能够直接拒绝。'),
    q(24, 'boundary', true, '为了维持一段关系，你经常会勉强自己接受原本不愿意接受的事情。'),
    q(25, 'boundary', true, '因为担心对方不高兴，你有时会把真正想说的话咽回去。'),

    // ⑥ 冲突敏感度 26–30
    q(26, 'conflictSensitivity', false, '对方说话的语气发生一点变化，你就能很快察觉出来。'),
    q(27, 'conflictSensitivity', false, '两个人发生争执以后，即使事情已经过去，你还是会在脑子里反复回想当时的细节。'),
    q(28, 'conflictSensitivity', false, '当对方突然变得安静或者冷淡时，你的情绪也很容易受到影响。'),
    q(29, 'conflictSensitivity', true, '两个人偶尔发生一点小摩擦，对你来说通常很快就过去了。'),
    q(30, 'conflictSensitivity', false, '当关系出现一点异常时，你很容易开始思考：“是不是出什么问题了？”')
  ],
  resultTypes: [
    {
      id: 'high-invest',
      title: '高投入型',
      rule: function (scores) {
        return scores.emotionalInvestment >= 70
      }
    },
    {
      id: 'balanced',
      title: '平衡型',
      rule: function () {
        return true
      }
    }
  ]
}

module.exports = relationshipV1
