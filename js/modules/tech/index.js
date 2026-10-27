// ============================================================
// tech/index.js —— 技术体检模块入口
// 二级标签：体检 / 修复 / 对比 / 历史。功能和重构前完全一致，只是拆成了几个文件。
// ============================================================
import { state, subscribe, currentRules, metricsOf } from '../../core/store.js';
import { $ } from '../../core/ui.js';
import { evaluate } from '../../lib/rules-engine.js';
import { clearOutputs } from '../../lib/history.js';
import { cleanOPFSDir } from '../../lib/webcodecs.js';
import { renderReport } from './report.js';
import { applySuggestedFixes, updateFixButton, doProcess, resetOutputs, renderFixTab, fixAvailability, FIX_DEFS } from './fixes.js';
import { renderCompare, renderSizeCompare } from './compare.js';
import { renderHistory, renderRecent, cleanupStorage, onHistoryAction, onRecentAction, onAutoLoadChange } from './history-view.js';

export const id = 'tech';
export const title = '技术体检';

/** 二级标签切换 */
function renderSubTabs() {
  document.querySelectorAll('#techTabs button[data-subtab]').forEach((b) => b.classList.toggle('on', b.dataset.subtab === state.techTab));
  document.querySelectorAll('[data-subpanel]').forEach((p) => { p.hidden = p.dataset.subpanel !== state.techTab; });
}

function render() {
  renderSubTabs();
  renderReport();
  renderFixTab();
  renderCompare();
}

/**
 * 交给“总报告”的条目：每条技术规格检查一条。
 * 统一格式：{ module, moduleName, status, title, value, reason, suggestion, goto }
 */
export function getReportItems() {
  const o = state.original;
  if (!o?.info) return null;
  const results = evaluate(currentRules(), metricsOf(o), { loudnessPending: o.loudPending });
  return results
    .filter((r) => r.status !== 'na')
    .map((r) => {
      const fixable = r.rule.fix && (r.status === 'warn' || r.status === 'fail') && fixAvailability(r.rule.fix) === true;
      const fixTitle = fixable ? FIX_DEFS.find((d) => d.id === r.rule.fix)?.title : null;
      return {
        module: id, moduleName: title,
        status: r.status, title: r.rule.item, value: r.actual, reason: r.message,
        suggestion: r.suggest || (fixTitle ? `可以在「技术体检 › 修复」里用「${fixTitle}」一键修复。` : ''),
        fixable,
        goto: fixable ? 'tech:fix' : 'tech:report',
      };
    });
}

function bindEvents() {
  $('#techTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-subtab]');
    if (!b) return;
    state.techTab = b.dataset.subtab;
    renderSubTabs();
  });

  // 修复
  $('#fixList').addEventListener('change', updateFixButton);
  $('#fixBtn').addEventListener('click', () => doProcess('fix'));
  $('#verticalBtn').addEventListener('click', () => doProcess('vertical'));

  // 对比
  $('#onlyChanged').addEventListener('change', renderCompare);
  // 上行带宽：改了就重算上传时间，并记在本机（下次打开还在）
  $('#bwInput').addEventListener('input', () => {
    try { localStorage.setItem('uploadMbps', $('#bwInput').value); } catch (e) { /* 隐私模式等情况下忽略 */ }
    renderSizeCompare();
  });
  // 同步播放：把“处理后”对齐到“处理前”的时间点再一起播放
  $('#syncPlay').addEventListener('click', () => {
    const b = $('#vBefore'), a = $('#vAfter');
    if (!a) return;
    if (b && !b.hidden) { a.currentTime = Math.min(b.currentTime, a.duration || b.currentTime); b.play(); }
    a.play();
  });
  $('#syncPause').addEventListener('click', () => { $('#vBefore')?.pause(); $('#vAfter')?.pause(); });

  // 历史
  $('#historyList').addEventListener('click', onHistoryAction);
  $('#recentList').addEventListener('click', onRecentAction);
  $('#autoLoadLast').addEventListener('change', onAutoLoadChange);
  $('#clearHistory').addEventListener('click', async () => {
    if (!confirm('清空全部处理结果？已保存的处理后视频会被删除，无法恢复。（最近导入的视频不受影响）')) return;
    await clearOutputs();
    // 删除磁盘上的结果文件；正在对比的、正在检查的那个先保留，下次重新处理 / 打开页面时再删
    const keep = new Set([state.fixed?.out?.onDisk && state.fixed.out.name, state.original?.ref?.name].filter(Boolean));
    await cleanOPFSDir('outputs', keep.size ? keep : null);
    if (state.fixed) state.fixed.historyId = null;
    $('#historyPlayer').innerHTML = '';
    await renderHistory();
  });
}

/** 挂载模块 */
export function mount() {
  bindEvents();
  try { const bw = localStorage.getItem('uploadMbps'); if (bw) $('#bwInput').value = bw; } catch (e) { /* 忽略 */ }
  cleanupStorage().then(renderHistory);
  subscribe((reason) => {
    if (reason === 'before-new-file') resetOutputs();               // 换视频：清掉上一次的处理结果
    if (reason === 'analyzed' || reason === 'platform') applySuggestedFixes(); // 新视频 / 换平台：重新建议修复项
    if (['recent', 'analyzed', 'busy', 'before-new-file'].includes(reason)) renderRecent();
    render();
  });
  render();
}
