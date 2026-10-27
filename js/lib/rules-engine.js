// ============================================================
// rules-engine.js —— 技术规格判定：对视频参数逐条检查 config/platforms.json 里的规则
// 状态：pass 通过 / warn 警告 / fail 不通过 / info 提示 / na 不适用 / pending 分析中
// （读取配置文件在 js/core/config.js）
// ============================================================

// 音频相关指标：没有音轨时这些规则标记为“不适用”
const AUDIO_METRICS = new Set(['audioCodec', 'audioBitrateKbps', 'sampleRate', 'channels', 'audioSilent', 'loudnessLUFS', 'truePeakDBTP', 'loudnessRangeLU']);
// 需要 ffmpeg 响度分析才有的指标
const LOUDNESS_METRICS = new Set(['audioSilent', 'loudnessLUFS', 'truePeakDBTP', 'loudnessRangeLU']);
// 音轨全程静音时无法测量的指标
const LEVEL_METRICS = new Set(['loudnessLUFS', 'truePeakDBTP', 'loudnessRangeLU']);

/** 各运算符的判定逻辑 */
const OPS = {
  in: (a, v) => v.includes(a),
  notIn: (a, v) => !v.includes(a),
  eq: (a, v) => a === v,
  ne: (a, v) => a !== v,
  gte: (a, v) => a >= v,
  lte: (a, v) => a <= v,
  gt: (a, v) => a > v,
  lt: (a, v) => a < v,
  between: (a, v) => a >= v[0] && a <= v[1],
  isTrue: (a) => a === true,
  isFalse: (a) => a === false,
};

// “实测”列显示用的单位（说明句子里的单位写在 JSON 模板中，这里不重复）
const UNITS = {
  width: ' px', height: ' px', shortSide: ' px', longSide: ' px', frameRate: ' fps', videoBitrateKbps: ' kbps',
  durationSec: ' 秒', fileSizeMB: ' MB', sampleRate: ' Hz', audioBitrateKbps: ' kbps', loudnessLUFS: ' LUFS', truePeakDBTP: ' dBTP', loudnessRangeLU: ' LU',
};

/** 把实测值转成适合放进句子里的文字 */
function displayActual(metric, m) {
  const a = m[metric];
  switch (metric) {
    case 'isHDR': return a ? `${m.hdrFormat}，色域 ${m.colorPrimaries}` : 'SDR';
    case 'isVFR': return a ? '可变帧率' : '固定帧率';
    case 'hasAudio': return a ? '有' : '无';
    case 'audioSilent': return a ? '全程静音' : '有声音';
    default: return Array.isArray(a) ? a.join(' / ') : String(a);
  }
}
const displayValue = (v) => (Array.isArray(v) ? (v.length === 2 && typeof v[0] === 'number' ? `${v[0]} ~ ${v[1]}` : v.join(' / ')) : String(v ?? ''));
const fill = (tpl, actual, value, tier = '') => (tpl || '').replaceAll('{actual}', actual).replaceAll('{value}', value).replaceAll('{tier}', tier);

/**
 * 分档要求：check 里写了 tiers 时，按视频的某个指标（tierBy，默认短边 shortSide）选出这一档的要求值。
 * tiers 按 upTo 从小到大排列，取第一个 “指标 ≤ upTo” 的档；最后一档可以不写 upTo（表示以上全部）。
 * 例：{ "metric": "videoBitrateKbps", "op": "gte", "tiers": [{ "upTo": 720, "value": 3000, "label": "720P" }, …] }
 * @returns {{value:any, tier:string}} tier 为档位名称（没有分档时为空）
 */
export function resolveCheck(check, m) {
  if (!Array.isArray(check?.tiers) || !check.tiers.length) return { value: check?.value, tier: '' };
  const x = m?.[check.tierBy || 'shortSide'];
  const t = check.tiers.find((t) => t.upTo === undefined || (x != null && x <= t.upTo)) || check.tiers[check.tiers.length - 1];
  return { value: t.value, tier: t.label || '' };
}

/**
 * 对一组规则做判定
 * @param {Array} rules 平台规则数组
 * @param {object} m    指标（probe 结果 + 响度结果合并）
 * @param {{loudnessPending:boolean}} ctx
 */
export function evaluate(rules, m, ctx = {}) {
  return rules.map((rule) => {
    const { metric, op } = rule.check;
    const { value, tier } = resolveCheck(rule.check, m); // 分档规则（如按清晰度定码率下限）在这里选出本档要求
    const base = { rule, actual: '—' };

    if (AUDIO_METRICS.has(metric) && m.hasAudio === false) {
      return { ...base, status: 'na', message: '无音轨，跳过此项。' };
    }
    if (LOUDNESS_METRICS.has(metric) && ctx.loudnessPending) {
      return { ...base, status: 'pending', message: '响度分析中…' };
    }
    if (LEVEL_METRICS.has(metric) && m.audioSilent) {
      return { ...base, status: 'na', message: '音轨全程静音，无法测量响度，跳过此项。' };
    }
    const a = m[metric];
    if (a === undefined || a === null) {
      // 读不到的值：硬性限制要提醒人工确认；经验建议 / 提示类直接跳过，避免无谓的警告（例如 MKV 不记录音频码率）
      return rule.type === 'hard'
        ? { ...base, status: 'warn', message: '无法从文件中读取该项，请人工确认。' }
        : { ...base, status: 'na', message: '文件里没有记录这一项，跳过。' };
    }
    const fn = OPS[op];
    if (!fn) return { ...base, status: 'warn', message: `规则写法有误：未知运算符 ${op}` };

    const actual = displayActual(metric, m);
    const ok = fn(a, value);
    return {
      rule,
      actual: actual + (UNITS[metric] || ''),
      // info（仅提示）类规则：满足时算通过，不满足时只给提示，不算问题
      status: ok ? 'pass' : rule.type === 'info' ? 'info' : rule.type === 'hard' ? 'fail' : 'warn',
      message: fill(ok ? rule.passMsg : rule.failMsg, actual, displayValue(value), tier),
      // 修复建议（只在不满足时有意义；总报告里显示）
      suggest: ok ? '' : fill(rule.suggest, actual, displayValue(value), tier),
    };
  });
}

/** 统计各状态数量，并给出总体结论 */
export function summarize(results) {
  const c = { pass: 0, warn: 0, fail: 0, info: 0, na: 0, pending: 0 };
  results.forEach((r) => c[r.status]++);
  c.verdict = c.fail > 0 ? 'fail' : c.warn > 0 ? 'warn' : 'pass';
  return c;
}

/** 根据未通过的规则，推断建议勾选的修复项 */
export function suggestFixes(results) {
  const s = new Set();
  results.forEach((r) => { if ((r.status === 'warn' || r.status === 'fail') && r.rule.fix) s.add(r.rule.fix); });
  return s;
}
