// ============================================================
// report.js —— 技术体检 › 体检：结论 + 问题列表（不通过 → 警告 → 提示），通过项折叠
// ============================================================
import { state, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, badge, verdictIcon, setHTML } from '../../core/ui.js';
import { reveal, animate, drawStroke, countUp, stagger, SPRING } from '../../core/motion.js';
import { evaluate, summarize } from '../../lib/rules-engine.js';
import { fixAvailability } from './fixes.js';

// ---------- 体检 ----------
const TYPE_TEXT = { hard: '硬性限制（不满足可能无法上传）', advice: '建议（不满足也能上传）', info: '仅提示' };

/** 一条检查结果（点开看要求、类型、来源） */
function checkRow(r) {
  const fixable = r.rule.fix && (r.status === 'warn' || r.status === 'fail') && fixAvailability(r.rule.fix) === true;
  return `<details class="check s-${r.status}">
    <summary>
      <span class="dot"></span>
      <div><div class="c-title">${esc(r.rule.item)}<span class="c-val">${esc(r.actual)}</span></div><div class="c-msg">${esc(r.message)}</div></div>
      <div class="c-side">${fixable ? `<button class="c-fix" data-open-fix="${esc(r.rule.fix)}">可修复</button>` : r.status === 'info' ? badge('info') : r.status === 'na' ? badge('na') : ''}</div>
    </summary>
    <div class="c-detail"><span>要求</span><b>${esc(r.rule.requirement)}</b><span>类型</span><b>${TYPE_TEXT[r.rule.type] || r.rule.type}</b><span>来源</span><b>${esc(r.rule.source)}（${esc(r.rule.date)}）</b></div>
  </details>`;
}

/** 结论里的计数：揭晓时从 0 滚动到实际值 */
const vnum = (n) => `<b class="vnum num" data-n="${n}">${n}</b>`;

/**
 * 结论揭晓：只在“文件 + 平台 + 结论 + 是否仍在分析”变化时播放（声音分析进度更新时的重渲染不重播）。
 * 还在分析声音时只淡入；分析完成那一刻才是完整的揭晓：从进度条的位置升起、图标一笔画出、数字滚动、问题依次出现。
 */
function revealReport(o, c) {
  const sum = $('#summary');
  const key = `${o.file.name}|${o.file.size}|${state.platform}|${c.verdict}|${c.pending ? 1 : 0}`;
  reveal(sum, key, () => {
    if (c.pending) { animate(sum, { opacity: [0, 1] }); return; }
    const task = $('#task');
    const dy = !task.hidden && task.offsetParent ? task.getBoundingClientRect().top - sum.getBoundingClientRect().top : 24;
    animate(sum, { y: [dy, 0], opacity: [0, 1] }, SPRING.soft);
    drawStroke(sum.querySelector('.verdict-icon svg'));
    sum.querySelectorAll('.vnum').forEach((el) => countUp(el, Number(el.dataset.n)));
    stagger($('#issueList').children, { gap: 0.04 });
  });
}

export function renderReport() {
  const o = state.original;
  const has = !!o?.info && !!state.config;
  $('#reportEmpty').hidden = has;
  $('#reportBody').hidden = !has;
  if (!has) { $('#countReport').textContent = ''; $('#countTech').textContent = ''; return; }
  const pname = currentPlatform().name;
  const results = evaluate(currentRules(), metricsOf(o), { loudnessPending: o.loudPending });
  const c = summarize(results);
  const title = {
    pass: `可以直接上传到${pname}`,
    warn: `可以上传到${pname}，有 ${c.warn} 项建议优化`,
    fail: `有 ${c.fail} 项不满足${pname}的硬性要求`,
  }[c.verdict];
  setHTML($('#summary'), `
    <div class="verdict-title">${verdictIcon(c.verdict)}${title}</div>
    <div class="verdict-meta">${badge('fail')} ${vnum(c.fail)} ${badge('warn')} ${vnum(c.warn)} ${badge('pass')} ${vnum(c.pass)}
      <span class="hint">按${pname}规则检查 ${results.length} 项${c.pending ? ' · 声音分析中…' : ''}</span></div>
    <div class="verdict-actions">
      <button class="btn ${c.fail + c.warn ? 'primary' : 'sm'}" id="openFix">一键修复</button>
      <span class="hint">${c.fail + c.warn ? '勾选的问题合并成一次处理，处理完可以直接下载' : '没有需要修复的问题，也可以转 MP4、压缩体积、横屏转竖屏'}</span>
    </div>`);

  // 先列问题（不通过 → 警告），再列提示 / 分析中；通过和不适用的折叠起来
  const order = { fail: 0, warn: 1, info: 2, pending: 3 };
  const top = results.filter((r) => r.status in order).sort((a, b) => order[a.status] - order[b.status]);
  const rest = results.filter((r) => !(r.status in order));
  setHTML($('#issueList'), top.map(checkRow).join('')); // 没有问题时结论下方已经说明，这里不再重复
  revealReport(o, c);
  $('#passSummary').textContent = `${c.pass} 项已通过${c.na ? `，${c.na} 项不适用` : ''}`;
  $('#passList').innerHTML = rest.map(checkRow).join('');
  $('#passGroup').hidden = !rest.length;

  const n = c.fail + c.warn;
  $('#countReport').textContent = n || '';
  $('#countReport').className = `count ${c.fail ? 'fail' : n ? 'warn' : ''}`;
  // 一级标签“技术体检”上也显示问题数
  $('#countTech').textContent = n || '';
  $('#countTech').className = `count ${c.fail ? 'fail' : n ? 'warn' : ''}`;
}

