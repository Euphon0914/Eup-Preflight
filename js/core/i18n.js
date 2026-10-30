// ============================================================
// i18n.js —— 中英文切换。界面源码和配置都用中文写，切到英文时把页面上出现的中文换成英文：
//   · 词典（js/i18n/en-*.js）的键是中文原文、值是英文；键里带 {名字} 的是模板，
//     如 '{n} 处需要注意：{title}' → '{n} issues: {title}'，{…} 匹配任意文字，匹配到的部分再单独翻译一次
//   · 英文模式下用 MutationObserver 盯着整个页面：各模块照常渲染中文，新出现的文字和
//     title / aria-label / placeholder / alt 属性在浏览器绘制之前就换成英文，不会闪一下中文
//   · 切回中文：把换过的文字还原（记着每一处的原文）
//   · 不经过页面的文字（alert / confirm）用 t('中文', { 变量 }) 翻译
//   · 文件名等不该翻译的地方加 translate="no"
// 词典里没有的中文保持原样，并记在 window.__i18nMisses 里，方便补词典（也可以运行 scripts/i18n-extract.py）。
// ============================================================
import DICT from '../i18n/en.js';

const HAN = /[㐀-鿿]/;
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const norm = (s) => s.replace(/\s+/g, ' ').trim();

let lang = 'zh';
export const getLang = () => lang;

// ---------- 词典：普通条目查表，带 {…} 的编译成正则 ----------
const exact = new Map();
const patterns = [];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [zh, en] of Object.entries(DICT)) {
  const key = norm(zh);
  if (!/\{\w+\}/.test(key)) {
    exact.set(key, en);
    // 拼接的句子按“。”拆开后没有句号，也要查得到
    const bare = key.replace(/[。.]$/, '');
    if (bare !== key && !exact.has(bare)) exact.set(bare, en.replace(/\.$/, ''));
    continue;
  }
  const names = [];
  const parts = key.split(/(\{\w+\})/);
  const literal = parts.filter((_, i) => i % 2 === 0).join('');
  if (!HAN.test(literal)) continue; // 只有占位符和符号的模板会匹配一切，不要
  // 占位符可以为空（如可选的后缀）。先按最短匹配试，翻不出来再按最长匹配试一次
  const src = (q) => parts.map((p, i) => (i % 2 ? `([\\s\\S]*${q})` : escRe(p))).join('');
  parts.forEach((p, i) => { if (i % 2) names.push(p.slice(1, -1)); });
  patterns.push({ res: [new RegExp(`^${src('?')}$`), new RegExp(`^${src('')}$`)], names, en, weight: literal.length });
}
patterns.sort((a, b) => b.weight - a.weight); // 字面部分越长越具体，先匹配

// ---------- 翻译一段文字 ----------
const memo = new Map();
const misses = new Set();
window.__i18nMisses = misses;

// 句子里的分隔符：整句查不到时按这些拆开分别翻译，再用英文标点接回去
const SEPS = [[' → ', ' → '], [' · ', ' · '], ['\n', '\n'], ['；', '; '], ['。', '. '], ['，', ', '], ['：', ': '], ['、', ', ']];
const WRAPS = [['（', '）', '(', ')'], ['(', ')', '(', ')'], ['「', '」', '“', '”'], ['“', '”', '“', '”'], ['《', '》', '“', '”']];

// 中文前后拼着不含中文的部分：结尾的（日期）、结尾空格后的“3:4”、开头空格前的数字
const AFFIXES = [
  /^([\s\S]*[\u3400-\u9fff][\s\S]*?)(（[^\u3400-\u9fff（）]*）)$/,
  /^([\s\S]*[\u3400-\u9fff][\s\S]*?)(\s+[^\u3400-\u9fff\s]+)$/,
  /^([^\u3400-\u9fff]+\s+)([\s\S]*[\u3400-\u9fff][\s\S]*)$/,
];

/** 翻译一段（已去掉首尾空白的）中文；查不到返回 null */
function lookup(c) {
  if (!HAN.test(c)) return c;
  const hit = exact.get(c);
  if (hit !== undefined) return hit;
  if (memo.has(c)) return memo.get(c);
  let r = null;
  memo.set(c, null); // 防止模板套模板时循环
  outer: for (const p of patterns) {
    for (const re of p.res) {
      const m = re.exec(c);
      if (!m) break;
      // 每个占位符匹配到的部分也要翻得出来，否则这次匹配不算（换一种切法或别的规则）
      const vals = {};
      let ok = true;
      p.names.forEach((k, i) => {
        const v = m[i + 1].trim();
        const t = lookup(v);
        if (t == null) ok = false;
        vals[k] = t;
      });
      if (!ok) continue;
      r = p.en.replace(/\{(\w+)\}/g, (all, k) => (k in vals ? vals[k] : all));
      break outer;
    }
  }
  // 括号包着的：只翻译里面
  if (r == null) {
    for (const [a, b, ea, eb] of WRAPS) {
      if (c.startsWith(a) && c.endsWith(b) && c.length > 2) {
        const inner = lookup(c.slice(a.length, -b.length).trim());
        if (inner != null) { r = ea + inner + eb; break; }
      }
    }
  }
  // 前后拼着不含中文的部分（“竖版封面 3:4”“规则来源（2026-10-23）”“2 处”）：只翻译中文那段
  for (const re of AFFIXES) {
    if (r != null) break;
    const m = re.exec(c);
    if (!m) continue;
    const [head, tail] = HAN.test(m[1]) ? [lookup(m[1].trim()), m[2]] : [m[1], lookup(m[2].trim())];
    if (head != null && tail != null) r = (head + tail).replace('（', ' (').replace('）', ')');
  }
  // 结尾的冒号、省略号、句号：去掉再查
  if (r == null) {
    const m = /^([\s\S]+?)\s*([：:…。！？]+)$/.exec(c);
    if (m) {
      const core = lookup(m[1]);
      if (core != null) r = core + m[2].replace(/：/g, ':').replace(/。/g, '.').replace(/！/g, '!').replace(/？/g, '?');
    }
  }
  // 按分隔符拆开
  if (r == null) {
    for (const [sep, en] of SEPS) {
      if (!c.includes(sep)) continue;
      const parts = c.split(sep).map((p) => p.trim());
      const out = parts.map((p) => (p ? lookup(p) : ''));
      if (out.every((x) => x != null)) { r = out.join(en).trim(); break; }
    }
  }
  memo.set(c, r);
  return r;
}

// 中文标点：拼接出来的句子里常有单独的“，”“（”这类片段，英文模式下换成英文标点
const PUNCT = /[，。；：、（）！？“”「」]/;
const PUNCT_MAP = { '，': ', ', '。': '. ', '；': '; ', '：': ': ', '、': ', ', '（': ' (', '）': ')', '！': '! ', '？': '? ', '“': '“', '”': '”', '「': '“', '」': '”' };
const punct = (s) => s.replace(/[，。；：、（）！？“”「」]/g, (c) => PUNCT_MAP[c]);

/** 翻译一段文字（保留首尾空白）；查不到时原样返回并记下来 */
export function tr(s) {
  if (lang !== 'en' || !s) return s;
  if (!HAN.test(s)) return PUNCT.test(s) ? punct(s) : s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = norm(m[2]);
  const r = lookup(core);
  if (r == null) { misses.add(core); return s; }
  let out = HAN.test(r) ? r : punct(r);
  if (/[：:]$/.test(core) && /:$/.test(out) && !m[3]) out += ' '; // “建议：”后面紧跟正文，英文冒号后要空一格
  return m[1] + out + m[3];
}

/**
 * 代码里直接用的翻译（alert、confirm 等不经过页面的文字）：t('删除这条记录？{name}', { name })
 * 中文模式下只是把 {名字} 换成变量
 */
export function t(zh, vars = {}) {
  let s = zh;
  if (lang === 'en') {
    const en = DICT[zh] ?? exact.get(norm(zh));
    if (en != null) s = en;
    else misses.add(norm(zh));
  }
  return s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}

// ---------- 页面上的文字 ----------
const textRec = new WeakMap(); // 文字节点 → { zh, en }
const attrRec = new WeakMap(); // 元素 → { 属性名: { zh, en } }
const live = new Set();        // 换过的节点，切回中文时逐个还原

const skipped = (el) => !!el?.closest?.('script, style, [translate="no"]');

function doText(n) {
  const d = n.data;
  const r = textRec.get(n);
  if (r && d === r.en) return; // 自己刚换上去的
  if (!(HAN.test(d) || PUNCT.test(d)) || skipped(n.parentElement)) return;
  const en = tr(d);
  if (en === d) return;
  textRec.set(n, { zh: d, en });
  live.add(n);
  n.data = en;
}

function doAttr(el, a) {
  const v = el.getAttribute(a);
  if (!v || !HAN.test(v)) return;
  const recs = attrRec.get(el) || {};
  if (recs[a] && v === recs[a].en) return;
  if (skipped(el)) return;
  const en = tr(v);
  if (en === v) return;
  recs[a] = { zh: v, en };
  attrRec.set(el, recs);
  live.add(el);
  el.setAttribute(a, en);
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) { doText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE || skipped(root)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches('script, style, [translate="no"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.currentNode; n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n);
    else for (const a of ATTRS) if (n.hasAttribute(a)) doAttr(n, a);
  }
}

const mo = new MutationObserver((list) => {
  for (const m of list) {
    if (m.type === 'characterData') doText(m.target);
    else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
    else m.addedNodes.forEach(walk);
  }
  if (live.size > 20000) for (const n of live) if (!n.isConnected) live.delete(n); // 清掉已经不在页面上的
});

function restore() {
  for (const n of live) {
    if (n.nodeType === Node.TEXT_NODE) {
      const r = textRec.get(n);
      if (r && n.data === r.en) n.data = r.zh;
      textRec.delete(n);
    } else {
      const recs = attrRec.get(n) || {};
      for (const [a, r] of Object.entries(recs)) if (n.getAttribute(a) === r.en) n.setAttribute(a, r.zh);
      attrRec.delete(n);
    }
  }
  live.clear();
}

/** 切换语言（'zh' | 'en'）：换掉 / 还原页面上已有的文字，之后渲染的内容由观察者处理 */
export function setLang(next) {
  next = next === 'en' ? 'en' : 'zh';
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
  if (next === lang) return;
  lang = next;
  if (lang === 'en') {
    walk(document.body);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  } else {
    mo.disconnect();
    restore();
  }
}
