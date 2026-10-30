// ============================================================
// summary/index.js —— 总报告：汇总各模块的结果
// 每个模块提供 getReportItems()，返回统一格式的条目（见 tech/index.js），返回 null 表示该模块还没检查。
// 排序：不通过 → 警告 → 提示 → 通过（通过的折叠起来）。
// ============================================================
import { state, subscribe, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, badge, verdictIcon, setHTML } from '../../core/ui.js';
import { reveal, animate, drawStroke, countUp, stagger } from '../../core/motion.js';
import { evaluate, summarize } from '../../lib/rules-engine.js';

export const id = 'summary';
export const title = '总报告';

let sources = []; // 参与汇总的模块

const ORDER = { fail: 0, warn: 1, info: 2, pending: 3, pass: 4 };
const GROUPS = [
  ['fail', '不通过', '不处理可能无法发布'],
  ['warn', '警告', '能发布，但建议处理'],
  ['info', '提示', '不算问题，了解一下就好'],
  ['pending', '分析中', ''],
];

/** 一条结果卡片 */
function itemCard(it) {
  return `<div class="sum-item s-${it.status}">
    <div class="sum-head">${badge(it.status)}<span class="sum-title">${esc(it.title)}</span>${it.value && it.value !== '—' ? `<span class="hint">${esc(it.value)}</span>` : ''}
      <span class="tag">${esc(it.moduleName)}</span></div>
    <div class="sum-reason">${esc(it.reason)}</div>
    ${it.suggestion ? `<div class="sum-suggest"><b>建议：</b>${esc(it.suggestion)}</div>` : ''}
    ${it.goto && it.status !== 'pass' ? `<button class="btn sm" data-goto="${esc(it.goto)}">${it.fixable ? '去修复' : '查看详情'}</button>` : ''}
  </div>`;
}

const vnum = (n) => `<b class="vnum num" data-n="${n}">${n}</b>`;

function render() {
  const has = !!state.original?.info && !!state.config;
  $('#summaryEmpty').hidden = has;
  $('#summaryBody').hidden = !has;
  if (!has) { $('#countSummary').textContent = ''; return; }

  const pname = currentPlatform()?.name || '';
  const perModule = sources.map((m) => ({ m, items: m.getReportItems() }));
  const items = perModule.flatMap(({ items }) => items || []).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const n = (s) => items.filter((x) => x.status === s).length;
  const fail = n('fail'), warn = n('warn'), pass = n('pass');

  // 结论
  const verdict = fail ? 'fail' : warn ? 'warn' : 'pass';
  const titleText = {
    fail: `有 ${fail} 项不满足${pname}的要求，发布前需要处理`,
    warn: `可以发布到${pname}，有 ${warn} 项建议先处理`,
    pass: `已检查的项目都没问题，可以发布到${pname}`,
  }[verdict];
  // 各模块状态：已检查几项问题 / 尚未检查
  const chips = perModule.map(({ m, items }) => {
    if (!items) return `<span class="mod-chip todo">${esc(m.title)}：尚未检查</span>`;
    const bad = items.filter((x) => x.status === 'fail' || x.status === 'warn').length;
    return `<span class="mod-chip ${bad ? 'bad' : 'ok'}">${esc(m.title)}：${bad ? `${bad} 项需要处理` : '没问题'}</span>`;
  }).join('');
  // 报告针对的是原视频；如果在技术体检里已经生成了处理后的版本，提示一下它的技术体检结果
  let fixedNote = '';
  const f = state.fixed;
  if (f?.info) {
    const c = summarize(evaluate(currentRules(), metricsOf(f), { loudnessPending: f.loudPending }));
    const left = c.fail + c.warn;
    fixedNote = `<div class="fixed-note">已用「一键修复」生成处理后的版本：技术体检${left ? `还剩 ${left} 项需要处理` : '的问题都已解决'}。
      <button class="btn ghost sm" data-goto="tech:compare">查看对比</button></div>`;
  }
  setHTML($('#summaryHead'), `
    <div class="verdict-title">${verdictIcon(verdict)}${titleText}</div>
    <div class="verdict-meta">${badge('fail')} ${vnum(fail)} ${badge('warn')} ${vnum(warn)} ${badge('pass')} ${vnum(pass)}
      <span class="hint">以下是原视频的检查结果</span></div>
    <div class="mod-chips">${chips}</div>${fixedNote}`);

  // 问题按严重程度分组列出
  setHTML($('#summaryList'), GROUPS.map(([s, name, desc]) => {
    const xs = items.filter((x) => x.status === s);
    if (!xs.length) return '';
    return `<section class="sum-group"><h3 class="sec-title">${name} <span class="hint">${desc}</span></h3>${xs.map(itemCard).join('')}</section>`;
  }).join('') || '<p class="hint">没有需要处理的问题。</p>');

  // 揭晓：和技术体检同一套，时长减半；任一模块的结果变了（数量变化）才重播
  const o = state.original;
  const key = `${o.file.name}|${o.file.size}|${state.platform}|${verdict}|${perModule.map((x) => (x.items ? x.items.length : '-')).join(',')}`;
  reveal($('#summaryHead'), key, () => {
    animate($('#summaryHead'), { opacity: [0, 1], scale: [0.97, 1] }, { duration: 0.2 });
    drawStroke($('#summaryHead .verdict-icon svg'));
    $('#summaryHead').querySelectorAll('.vnum').forEach((el) => countUp(el, Number(el.dataset.n), { duration: 0.4 }));
    stagger($('#summaryList').querySelectorAll('.sum-item'), { gap: 0.02 });
  });

  const passed = items.filter((x) => x.status === 'pass');
  $('#summaryPassGroup').hidden = !passed.length;
  $('#summaryPassSummary').textContent = `${passed.length} 项已通过`;
  $('#summaryPassList').innerHTML = passed.map(itemCard).join('');

  $('#countSummary').textContent = fail + warn || '';
  $('#countSummary').className = `count ${fail ? 'fail' : fail + warn ? 'warn' : ''}`;
}

/** 挂载：modules 为参与汇总的模块列表（技术体检、画面遮挡检查、封面适配） */
export function mount(modules) {
  sources = modules;
  subscribe(() => render());
  render();
}
