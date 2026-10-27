// ============================================================
// config-format.js —— 把配置对象写回成 config/platforms.json 的排版
// 和手工维护的文件保持同一种风格，方便对比改动：
//   · 每条规则的 check、瘦身码率 targetKbps、播放区域 videoArea、每个遮挡区域写成一行
//   · 只含数字 / 文字的短列表写成一行（_说明 除外，逐行写）
//   · 其余对象逐层缩进 2 个空格
// ============================================================

const INLINE_KEYS = new Set(['check', 'targetKbps', 'videoArea']);

/** 写成一行：{ "a": 1, "b": [1, 2] } */
function oneLine(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

const isPrimitiveArray = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');

function fmt(v, indent, key, parentKey) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (INLINE_KEYS.has(key) || parentKey === 'zones' || (isPrimitiveArray(v) && key !== '_说明')) return oneLine(v);
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => inner + fmt(x, inner, undefined, key)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner, k, key)}`).join(',\n')}\n${indent}}`;
}

/** 排版整个配置对象，末尾带换行 */
export function formatConfig(cfg) {
  return fmt(cfg, '') + '\n';
}

/** 排版一个片段（例如某个平台的 "overlay"），用于复制粘贴 */
export function formatSnippet(key, value, indent = '      ') {
  return `${indent}${JSON.stringify(key)}: ${fmt(value, indent, key)}`;
}
