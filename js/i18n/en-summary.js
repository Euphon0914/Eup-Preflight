// 英文词典 · 总报告（js/modules/summary）
// 键是界面上的中文原文（空白合并成一个空格），值是英文；{名字} 是占位符，匹配任意文字，英文里放在对应位置。
// 补漏翻：python3 scripts/i18n-extract.py，或在英文模式下看 window.__i18nMisses。说明见 js/core/i18n.js
export default {
  "不处理可能无法发布": "May not be postable unless fixed",
  "能发布，但建议处理": "Can be posted, but fixing is recommended",
  "不算问题，了解一下就好": "Not a problem — just good to know",
  "有 {0} 项不满足{1}的要求，发布前需要处理": "{0} items don't meet {1}'s requirements and need fixing before posting",
  "可以发布到{0}，有 {1} 项建议先处理": "Can be posted on {0}; {1} items are worth fixing first",
  "已检查的项目都没问题，可以发布到{0}": "Everything checked looks fine — ready to post on {0}",
  "{0}：尚未检查": "{0}: not checked yet",
  "已用「一键修复」生成处理后的版本：技术体检{0}。": "A processed version was made with “One-click fix”: tech check {0}.",
  "查看对比": "View comparison",
  "以下是原视频的检查结果": "Below are the results for the original video",
  "没有需要处理的问题。": "Nothing needs fixing.",
  "{0} 项已通过": "{0} passed",
  "去修复": "Fix it",
  "查看详情": "Details",
  "{0} 项需要处理": "{0} to fix",
  "没问题": "All good",
  "还剩 {0} 项需要处理": "still has {0} to fix",
  "的问题都已解决": "issues are all resolved",
};
