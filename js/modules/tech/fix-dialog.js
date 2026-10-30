// ============================================================
// fix-dialog.js —— 一键修复弹窗 + “处理好的视频”结果条
//   体检结论旁的「一键修复」、每条问题的「可修复」、总报告的「去修复」都打开这个弹窗。
//   弹窗三个状态：选择修复项 → 处理中（进度条挪进弹窗）→ 完成（下载 / 查看对比）。
//   处理好的视频在「体检」和「对比」顶部常驻一条结果条，随时可以下载。
// ============================================================
import { state, goto, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, badge, fmtMB, stampName, clearError, clearFailedStages, verdictIcon } from '../../core/ui.js';
import { animate, flyFrom, pulse, SPRING } from '../../core/motion.js';
import { evaluate } from '../../lib/rules-engine.js';
import { doProcess, selectedFixes, updateFixButton } from './fixes.js';

const RANK = { fail: 0, warn: 1, pass: 2 };
let taskHome = null; // 进度条 / 错误框在面板上的原位置（关闭弹窗时放回去）
let view = 'pick';   // 弹窗当前状态

const dlg = () => $('#fixDialog');

/** 处理前后按当前平台规则比较：变好 / 变差各几项；solved 是从“警告 / 不通过”变成“通过”的项 */
function delta() {
  const o = state.original, f = state.fixed;
  if (!o?.info || !f?.info) return null;
  const before = evaluate(currentRules(), metricsOf(o), { loudnessPending: o.loudPending });
  const after = evaluate(currentRules(), metricsOf(f), { loudnessPending: f.loudPending });
  return {
    improved: before.filter((b, i) => RANK[after[i].status] > RANK[b.status]).length,
    regressed: before.filter((b, i) => RANK[after[i].status] < RANK[b.status]).length,
    solved: before.filter((b, i) => (b.status === 'warn' || b.status === 'fail') && after[i].status === 'pass'),
  };
}
const deltaText = (d) => d ? `${d.improved} 项变好${d.regressed ? `，${d.regressed} 项变差` : '，没有变差的项'}` : '';
const downloadName = () => stampName(state.fixed.file.name, state.fixed.createdAt || Date.now());

/** 弹窗显示哪一部分：pick 选择修复项 / running 处理中 / done 完成 */
function setView(v) {
  view = v;
  $('#fixPick').hidden = view !== 'pick';
  $('#fixPickFoot').hidden = view !== 'pick';
  $('#fixDone').hidden = view !== 'done';
  $('#fixDlgTitle').textContent = { pick: '一键修复', running: '正在处理…', done: '处理完成' }[view];
  $('#fixDlgSub').hidden = view === 'done';
  $('#fixDlgSub').textContent = view === 'running'
    ? '可以关掉这个窗口，处理会在后台继续，完成后在「体检」顶部下载。'
    : '勾选的项目合并成一次处理，输出 MP4；视频只在本机处理，不会上传。';
}

/** 完成页：大大的下载按钮 + 查看对比 */
function renderDone() {
  const f = state.fixed, o = state.original;
  const d = delta();
  $('#fixDone').innerHTML = `
    <div class="done-head">
      ${verdictIcon(d?.regressed ? 'warn' : 'pass')}
      <div>
        <div class="done-title">${f.kind === 'vertical' ? '竖屏版已生成' : '视频已修复好'}</div>
        <div class="hint">按${esc(currentPlatform().name)}规则：${deltaText(d)} · ${fmtMB(o.file.size)} → ${fmtMB(f.file.size)}</div>
      </div>
    </div>
    ${d?.solved.length ? `<div class="done-flips">${d.solved.map((r) => `<span class="flip">${badge(r.status)}<span>${esc(r.rule.item)}</span></span>`).join('')}</div>` : ''}
    <a class="btn primary big" href="${f.url}" download="${esc(downloadName())}">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      下载处理后的视频（MP4）</a>
    <p class="hint done-file">${esc(downloadName())}　·　也会保存在「历史」里，刷新页面不会丢</p>
    <div class="done-actions">
      <button class="btn" data-act="compare">查看前后对比</button>
      <button class="btn ghost" data-act="again">重新选择修复项</button>
      <button class="btn ghost" data-act="close">完成</button>
    </div>
    <details class="done-plan"><summary>处理明细（${f.plan.length} 条）</summary>
      <ul>${f.plan.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${f.args?.length ? `<pre class="tech-detail">ffmpeg ${esc(f.args.join(' '))}</pre>` : ''}
    </details>`;
}

/**
 * 完成时的揭晓：解决了的问题标签逐个翻转成“通过”，然后下载按钮亮一下。
 * 只在“处理中 → 完成”时播放一次（重新打开弹窗看完成页不重播）。
 */
function playDone() {
  const flips = [...$('#fixDone').querySelectorAll('.flip .badge')];
  flips.forEach((b, i) => {
    setTimeout(() => {
      animate(b, { rotateX: [0, 90] }, { duration: 0.14 }).then(() => {
        b.outerHTML = badge('pass');
        const nb = $('#fixDone').querySelectorAll('.flip')[i]?.querySelector('.badge');
        animate(nb, { rotateX: [-90, 0] }, SPRING.snappy);
      });
    }, 250 + i * 120);
  });
  setTimeout(() => pulse($('#fixDone .btn.primary.big')), 300 + flips.length * 120 + 250);
}

/** 「体检」「对比」顶部的结果条：有处理好的视频就一直显示，随时下载 */
export function renderFixedBars() {
  const f = state.fixed;
  const ready = !!(f?.info && f.url);
  const bar = (withCompare) => !ready ? '' : `
    <span class="fb-icon">✓</span>
    <div class="fb-text"><b>${f.kind === 'vertical' ? '竖屏版已生成' : '已处理好的视频'}</b>
      <span class="hint">${esc(downloadName())} · ${fmtMB(f.file.size)}${delta() ? ' · ' + deltaText(delta()) : ''}</span></div>
    <a class="btn primary sm" href="${f.url}" download="${esc(downloadName())}">下载 MP4</a>
    ${withCompare ? '<button class="btn ghost sm" data-goto="tech:compare">看对比</button>' : ''}`;
  $('#fixedBar').hidden = !ready;
  $('#fixedBar').innerHTML = bar(true);
  $('#compareFixedBar').innerHTML = bar(false);
}

/**
 * 打开弹窗
 * @param {string} [focusId] 从某条问题的「可修复」打开时，勾上并定位到对应的修复项
 * @param {Element} [originEl] 被点的按钮：弹窗从它的位置展开
 */
export function openFixDialog(focusId, originEl) {
  if (!state.original?.info) return;
  const d = dlg();
  // 进度条和错误框挪进弹窗，处理时看得到、能取消
  $('#dlgTaskSlot').append($('#task'), $('#errorBox'));
  // 正在处理时重新打开：继续显示进度；刚处理完：显示完成页（可下载）；其他情况回到选择修复项
  const keepDone = view === 'done' && state.fixed?.info && !focusId;
  if (view !== 'running' && !keepDone) { clearError(); setView('pick'); }
  if (!d.open) {
    d.showModal();
    const box = d.querySelector('.dlg-box');
    const r = originEl?.isConnected ? originEl.getBoundingClientRect() : null;
    if (r?.width) { flyFrom(r, box); animate(box, { opacity: [0, 1] }, { duration: 0.2 }); }
    else animate(box, { opacity: [0, 1], y: [12, 0] }, SPRING.soft);
  }
  if (focusId && view === 'pick') {
    const box = document.querySelector(`#fixList input[data-fix="${focusId}"]`);
    if (box && !box.disabled) {
      box.checked = true;
      updateFixButton();
      const more = box.closest('details');
      if (more) more.open = true;
      const item = box.closest('.fix-item');
      item.scrollIntoView({ block: 'center' });
      item.classList.remove('flash');
      void item.offsetWidth; // 重新触发高亮动画
      item.classList.add('flash');
    }
  }
}

function closeFixDialog() {
  if (dlg().open) dlg().close();
}

/** 关闭后把进度条 / 错误框放回面板原位置 */
function restoreTask() {
  if (!taskHome) return;
  clearFailedStages(); // 失败的阶段清单只在弹窗里看，放回面板前收起（错误提示留在面板上）
  taskHome.parent.insertBefore($('#task'), taskHome.ref);
  taskHome.parent.insertBefore($('#errorBox'), taskHome.ref);
}

async function run(kind) {
  if (kind === 'fix' && !Object.values(selectedFixes()).some(Boolean)) { alert('请至少勾选一项修复'); return; }
  setView('running');
  const ok = await doProcess(kind);
  if (ok) {
    renderDone();
    setView('done');
    playDone();
  } else {
    setView('pick'); // 失败或取消：错误信息显示在弹窗顶部，可以改选后重试
  }
  renderFixedBars();
}

export function bindFixDialog() {
  taskHome = { parent: $('#task').parentNode, ref: $('#errorBox').nextSibling };
  const d = dlg();
  $('#fixBtn').addEventListener('click', () => run('fix'));
  $('#verticalBtn').addEventListener('click', () => run('vertical'));
  $('#fixList').addEventListener('change', updateFixButton);
  $('#fixDlgClose').addEventListener('click', closeFixDialog);
  d.addEventListener('close', restoreTask);
  // 点弹窗外的半透明背景也能关闭
  d.addEventListener('click', (e) => { if (e.target === d) closeFixDialog(); });
  $('#fixDone').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'compare') { closeFixDialog(); goto('tech:compare'); }
    if (act === 'again') { clearError(); setView('pick'); }
    if (act === 'close') closeFixDialog();
  });
}
