// ============================================================
// ui.js —— 各模块共用的界面小工具：取元素、转义、格式化、状态标签、进度条、错误提示、耗时表
// ============================================================
import { state, notify } from './store.js';
import { canUseMT } from '../lib/ffmpeg-tools.js';
import { hasWebCodecs } from '../lib/webcodecs.js';
import { drawStroke, stagger } from './motion.js';

export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 状态标签 ----------
export const STATUS_TEXT = { pass: '通过', warn: '警告', fail: '不通过', info: '提示', na: '不适用', pending: '分析中' };
// “通过”带对勾：和品牌色柠檬绿区分开，不只靠颜色
export const badge = (s) => `<span class="badge ${s}">${s === 'pass' ? '✓ ' : ''}${STATUS_TEXT[s]}</span>`;

// ---------- 格式化 ----------
export const pad = (n) => String(n).padStart(2, '0');
/** 时间戳 → “10-22 16:46:32” */
export const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
/** 秒数 → “x 分 y 秒” */
export const fmtSec = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒`);
export const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes > 100 * 1048576 ? 0 : 1)} MB`;
/** 秒数 → “1:05” */
export const fmtClock = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
export const fmtRate = (k) => (k == null ? '—' : k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${k} kbps`);
/** 给文件名加上处理时间，下载多次也不会互相覆盖：xxx_fixed.mp4 → xxx_fixed_20261022-153012.mp4 */
export function stampName(name, ts) {
  const d = new Date(ts);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return name.replace(/(\.[^.]+)?$/, (ext) => `_${stamp}${ext || '.mp4'}`);
}

// ---------- 进度条 / 错误提示（右侧顶部，所有标签页共用） ----------
export function showTask(label, pct = null) {
  $('#task').hidden = false;
  $('#taskLabel').textContent = label;
  $('#taskPct').textContent = pct === null ? '' : `${Math.round(pct * 100)}%`;
  $('#taskBar').style.width = pct === null ? '100%' : `${pct * 100}%`;
  $('#taskBar').style.opacity = pct === null ? '.35' : '1';
}
export function hideTask() {
  $('#task').hidden = true;
  $('#taskStages').innerHTML = '';
  stagesOn = false;
}

// ---------- 阶段清单（进度条上方，每完成一步打一个勾） ----------
// 用法：任务开始时 beginStages()，每进入一步调 stage('步骤名')；没调 beginStages 时 stage 什么也不做，
// 所以底层函数（例如加载 ffmpeg）可以放心调用。走不到的步骤不调用，清单里就不会出现。
let stagesOn = false;
const STAGE_ICON = '<span class="st-ico"><svg viewBox="0 0 16 16" aria-hidden="true"><polyline points="4 8.5 7 11.5 12.5 5"/></svg></span>';

export function beginStages() {
  stagesOn = true;
  $('#taskStages').innerHTML = '';
}

export function stage(name) {
  if (!stagesOn) return;
  const list = $('#taskStages');
  const cur = list.querySelector('li.on');
  if (cur?.dataset.name === name) return;
  if (cur) { cur.className = 'done'; drawStroke(cur.querySelector('svg')); }
  let li = [...list.children].find((x) => x.dataset.name === name);
  if (!li) {
    li = document.createElement('li');
    li.dataset.name = name;
    li.innerHTML = `${STAGE_ICON}<span>${esc(name)}</span>`;
    list.append(li);
    stagger([li], { y: 4 });
  }
  li.className = 'on';
}

/** 当前步骤出错：标红叉，之后的 stage() 不再生效（清单保留，直到下次 hideTask） */
export function failStage() {
  const cur = $('#taskStages li.on');
  if (cur) cur.className = 'err';
  stagesOn = false;
}
export function showError(msg) { $('#errorBox').hidden = false; $('#errorBox').textContent = msg; }
export const clearError = () => { $('#errorBox').hidden = true; };

/** 忙 / 闲切换：各模块在渲染时根据 state.busy 禁用自己的按钮 */
export function setBusy(b) {
  state.busy = b;
  notify('busy');
}

/** “高级”里选择的 ffmpeg 核心：mt 多线程（需要浏览器支持）/ st 单线程 */
export const currentMode = () => ($('#modeSel')?.value === 'mt' && canUseMT() ? 'mt' : 'st');

// ---------- 耗时统计（“高级”面板） ----------
/** 包装一个异步步骤，自动记录耗时（失败也记录）。note 可以是函数：任务结束后再生成 */
export async function timed(step, fileName, mediaSec, fn, note = '') {
  const t0 = performance.now();
  let ok = false;
  try {
    const r = await fn();
    ok = true;
    return r;
  } finally {
    const n = typeof note === 'function' ? note() : note;
    state.timings.push({ step, fileName, ms: performance.now() - t0, mediaSec, note: ok ? n : `${n} 失败/取消`.trim() });
    renderTimings();
  }
}

/** 直接记一条耗时（不包装函数时用） */
export function addTiming(t) {
  state.timings.push(t);
  renderTimings();
}

export function renderTimings() {
  const mode = currentMode();
  $('#envInfo').textContent =
    `环境：CPU 逻辑核心 ${navigator.hardwareConcurrency || '?'} · crossOriginIsolated=${self.crossOriginIsolated} · ` +
    `多线程${canUseMT() ? '可用' : '不可用（需 COOP/COEP 响应头）'} · 当前核心：${mode === 'mt' ? '多线程' : '单线程'} · ` +
    `WebCodecs ${hasWebCodecs() ? '可用（视频转码、截图优先走硬件）' : '不可用（视频转码会退回 ffmpeg.wasm，很慢）'}`;
  if (!state.timings.length) {
    $('#timingTable').innerHTML = '<tr><td class="hint">还没有记录。拖入视频后，这里会显示每一步耗时。</td></tr>';
    return;
  }
  const rows = state.timings.map((t) => {
    const sec = t.ms / 1000;
    // 速度倍率 = 媒体时长 / 处理耗时，>1 表示比实时快
    const speed = t.mediaSec && sec > 0 ? `${(t.mediaSec / sec).toFixed(2)}x` : '—';
    return `<tr><td>${esc(t.step)}</td><td>${esc(t.fileName)}</td><td class="num">${sec.toFixed(2)} s</td>
      <td class="num">${t.mediaSec ? t.mediaSec.toFixed(1) + ' s' : '—'}</td><td class="num">${speed}</td><td class="hint">${esc(t.note)}</td></tr>`;
  }).join('');
  $('#timingTable').innerHTML = `<tr><th>步骤</th><th>文件</th><th>耗时</th><th>媒体时长</th><th>速度（x 实时）</th><th>备注</th></tr>${rows}`;
}
