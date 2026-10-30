// ============================================================
// shell.js —— 页面外壳：顶栏（平台切换、最近、高级）、左栏（拖入 / 视频卡片 / 步骤导航）、右侧大标题
// 左栏所有模块共用：视频只拖入一次。
// ============================================================
import { state, subscribe, notify, goto, autoChecksEnabled, setAutoChecks } from './store.js';
import { $, esc, fmtClock, fmtRate, showError, renderTimings, setHTML, recentThumbHtml, fillRecentThumbs } from './ui.js';
import { loadVideo, loadTestVideo } from './media.js';
import { listRecent, openRecent } from '../lib/recent-videos.js';
import { animate, stagger, SPRING, DUR, EASE } from './motion.js';
import { attachSegSlider } from './seg-slider.js';
import { terminateFFmpeg } from '../lib/ffmpeg-tools.js';

// ---------- 步骤导航（一级标签）+ 右侧大标题 ----------
const TITLES = {
  tech: ['技术体检', '格式、清晰度、流畅度、色彩、声音是否符合平台要求，不符合的可以一键修复'],
  occlusion: ['画面遮挡', '把视频按播放页的样子摆好，看字幕和文字会不会被按钮、文案挡住或被裁掉'],
  cover: ['封面适配', '选一帧或上传封面图，按平台的各个封面比例裁切预览并导出'],
  summary: ['总报告', '所有检查结果汇总在一起，按轻重排好，每条附原因和修改建议'],
};
let shownTab = null; // 上一次显示的步骤（切换步骤时右侧内容淡入）

function renderTabs() {
  document.querySelectorAll('#mainTabs button[data-tab]').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== state.tab; });
  const [t, sub] = TITLES[state.tab] || ['', ''];
  const tabs = Object.keys(TITLES), no = (n) => String(n).padStart(2, '0');
  $('#panelNo').textContent = `${no(tabs.indexOf(state.tab) + 1)} / ${no(tabs.length)}`;
  $('#panelTitle').textContent = t;
  $('#panelSub').textContent = sub;
  if (shownTab && shownTab !== state.tab) {
    const panel = document.querySelector(`[data-panel="${state.tab}"]`);
    [document.querySelector('.panel-title'), panel].forEach((el) => animate(el, { opacity: [0, 1], y: [8, 0] }, { duration: DUR.base, ease: EASE }));
  }
  shownTab = state.tab;
}

// ---------- 顶栏：“最近”菜单（最近导入的视频，点一下直接载入） ----------
function renderRecentMenu() {
  const list = listRecent();
  const cur = state.original?.file;
  const isCur = (r) => cur && cur.name === r.name && cur.size === r.size && cur.lastModified === r.lastModified;
  const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1048576).toFixed(1)} MB`);
  const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  $('#recentMenu').innerHTML = (list.length
    ? list.map((r) => `<button class="menu-item ${isCur(r) ? 'on' : ''}" role="menuitem" data-rid="${r.id}">${recentThumbHtml(r)}
        <span class="m-txt"><span class="m-name">${esc(r.name)}</span><span class="m-sub">${size(r.size)} · ${when(r.usedAt)}${r.opfs.dir === 'outputs' ? ' · 处理结果' : ''}</span></span></button>`).join('')
    : '<div class="menu-empty">导入的视频会出现在这里，下次打开页面不用重新选文件。</div>')
    + '<div class="menu-sep"></div><button class="menu-item" role="menuitem" data-goto="tech:history"><span class="m-name">管理最近的视频和处理结果…</span></button>';
  fillRecentThumbs($('#recentMenu'));
}
function toggleRecent(open) {
  const m = $('#recentMenu');
  open = open ?? m.hidden;
  if (open) renderRecentMenu();
  m.hidden = !open;
  $('#recentBtn').setAttribute('aria-expanded', String(open));
  $('#recentBtn').classList.toggle('on', open);
}

// ---------- 顶栏：平台按钮（按配置生成，只显示 platforms 里的平台） ----------
function renderPlatforms() {
  const plats = state.config?.platforms || {};
  if (!plats[state.platform]) state.platform = Object.keys(plats)[0] || state.platform;
  $('#platformSeg').innerHTML = Object.entries(plats)
    .map(([id, p]) => `<button data-platform="${esc(id)}" class="${id === state.platform ? 'on' : ''}">${esc(p.name)}</button>`).join('');
}

// ---------- 左栏：预览 + 关键参数 ----------
/** 参数列表的每一行：[名称, 等宽代号, 主值(info, loud, slot), 小字说明(info, loud, slot)] —— 只放判断“能不能传”最关键的几项 */
const PARAM_ROWS = [
  ['画面尺寸', 'RES', (i) => (i.width ? `${i.width}×${i.height}` : '—'), (i) => (i.aspectRatio ? `${i.aspectRatio} · ${i.orientation}` : '')],
  ['流畅度', 'FPS', (i) => (i.frameRate != null ? `每秒 ${i.frameRate} 帧` : '—'), (i) => (i.hasVideo ? (i.isVFR ? '帧率不稳定' : '帧率稳定') : '')],
  ['视频', 'VIDEO', (i) => (i.hasVideo ? `${i.videoCodec} · ${fmtRate(i.videoBitrateKbps)}` : '无画面'), () => ''],
  ['色彩', 'COLOR', (i) => (i.hasVideo ? (i.isHDR ? `HDR · ${i.hdrFormat}` : '普通（SDR）') : '—'), (i) => (i.hasVideo && i.bitDepth ? `${i.bitDepth} bit` : '')],
  ['时长', 'DUR', (i) => fmtClock(i.durationSec), () => ''],
  ['大小', 'SIZE', (i) => `${i.fileSizeMB} MB`, (i) => i.container],
  ['声音', 'AUDIO', (i) => (i.hasAudio ? `${i.audioCodec} · ${i.channels} 声道` : '没有声音'), (i) => (i.sampleRate ? `${i.sampleRate / 1000} kHz` : '')],
  ['音量', 'LUFS', (i, l, s) => (!i.hasAudio ? '—' : s.loudPending ? '分析中…' : l?.audioSilent ? '全程无声' : l ? `${l.loudnessLUFS} LUFS` : '分析失败'),
    (i, l) => (l && !l.audioSilent ? `峰值 ${l.truePeakDBTP} dBTP` : '')],
];

let lastFixedUrl = null; // 上一次播放“参数变化”动画时的处理结果（同一个结果只播一次）

function renderLeft() {
  const o = state.original, f = state.fixed;
  const has = !!o?.info;
  $('#drop').hidden = has;
  $('#mediaCard').hidden = !has;
  $('#testBtn').disabled = state.busy;
  $('#mediaCard').classList.toggle('scanning', state.busy); // 分析 / 处理中：视频上一条扫描线来回扫
  if (!has) return;

  // 预览：原片 / 处理后（有处理结果时才出现切换按钮）
  $('#previewSeg').hidden = !f?.url;
  if (!f?.url) state.previewSrc = 'original';
  document.querySelectorAll('#previewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.src === state.previewSrc));
  if (!o.url) o.url = URL.createObjectURL(o.file);
  const url = state.previewSrc === 'fixed' && f?.url ? f.url : o.url;
  const v = $('#previewVideo');
  if (v.dataset.src !== url) {
    v.dataset.src = url;
    v.hidden = false;
    $('#previewNote').hidden = true;
    v.src = url;
  }

  // 参数：有处理结果时，变化的值显示为“原值 → 新值”
  const showFixed = f?.info && state.previewSrc === 'fixed';
  $('#fileNote').hidden = !o.restored;
  $('#fileName').textContent = (showFixed ? f : o).file.name;
  $('#fileName').title = (showFixed ? f : o).file.name;
  const i = o.info; // 收起时的一行摘要
  $('#playerTag').textContent = i.width ? [i.aspectRatio, `${i.width}×${i.height}`, i.frameRate != null ? `${i.frameRate}FPS` : ''].filter(Boolean).join(' · ') : ''; // 预览左上角的读数
  $('#paramBrief').textContent = [i.width ? `${i.width}×${i.height}` : '', i.frameRate != null ? `${i.frameRate} 帧` : '',
    fmtClock(i.durationSec), `${i.fileSizeMB} MB`].filter(Boolean).join(' · ');
  setHTML($('#paramList'), PARAM_ROWS.map(([k, code, main, sub]) => {
    const a = main(o.info, o.loud, o);
    let as = sub(o.info, o.loud, o);
    let val = esc(a);
    if (f?.info) {
      const b = main(f.info, f.loud, f), bs = sub(f.info, f.loud, f);
      if (b !== a) val = `<span class="old">${esc(a)}</span><span class="new">${esc(b)}</span>`;
      if (bs !== as) as = as && bs ? `${as} → ${bs}` : bs || as; // 小字说明也显示变化
    }
    return `<div class="pcell"><dt>${k}<i class="mono-tag">${code}</i></dt><dd>${val}${as ? `<span class="sub">${esc(as)}</span>` : ''}</dd></div>`;
  }).join(''));
  // 修复完成后第一次显示新参数：旧值划掉、新值依次出现
  if (f?.info && f.url !== lastFixedUrl) {
    lastFixedUrl = f.url;
    $('#paramList').classList.remove('strike-in');
    void $('#paramList').offsetWidth;
    $('#paramList').classList.add('strike-in');
    stagger($('#paramList').querySelectorAll('.new'), { gap: 0.08, y: 4 });
  }
}

// ---------- 事件 ----------
function bindEvents() {
  // 视频参数展开 / 收起：记住上次的选择；没选过时宽屏展开、窄屏（手机、侧边窗口）收起，少占位置
  const fold = $('#paramFold');
  let pref = null;
  try { pref = localStorage.getItem('paramsOpen'); } catch { /* 隐私模式等情况下读不到 */ }
  fold.open = pref === null ? !matchMedia('(max-width: 900px)').matches : pref === '1';
  fold.addEventListener('toggle', () => { try { localStorage.setItem('paramsOpen', fold.open ? '1' : '0'); } catch { /* 忽略 */ } });
  const drop = $('#drop'), input = $('#fileInput');
  // 选文件：点拖放区任意位置（“生成测试视频”除外）或“换一个”
  drop.addEventListener('click', (e) => { if (!e.target.closest('#testBtn')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  $('#changeBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) loadVideo(input.files[0]); input.value = ''; });
  $('#testBtn').addEventListener('click', (e) => { e.stopPropagation(); loadTestVideo(); });
  // 整个页面都可以拖放
  const drops = [drop, $('#heroDrop')]; // 工作台左栏和首屏的拖放区
  // 拖着文件进入页面：四周亮起品牌色光边、拖放区微微放大；松手时拖放区回弹一下
  const dragOff = () => { document.body.classList.remove('dragging'); drops.forEach((d) => d.classList.remove('over')); };
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add('dragging'); drops.forEach((d) => d.classList.add('over')); }));
  document.addEventListener('dragleave', (e) => { e.preventDefault(); if (!e.relatedTarget) dragOff(); }); // 离开窗口时 relatedTarget 为空
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOff();
    drops.forEach((d) => { if (d.offsetParent) animate(d, { scale: [0.97, 1] }, SPRING.snappy); });
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    // 拖进来的是图片：当作封面图，交给“封面适配”
    if (f.type.startsWith('image/')) { state.coverImage = f; state.view = 'workspace'; goto('cover'); notify('cover-image'); return; }
    loadVideo(f);
  });

  // 顶栏：平台切换（只需重新判定，不必重新分析）、高级
  $('#platformSeg').addEventListener('click', (e) => {
    const p = e.target.dataset.platform;
    if (!p || p === state.platform) return;
    state.platform = p;
    renderPlatforms();
    notify('platform');
  });
  $('#advBtn').addEventListener('click', () => {
    const open = $('#advPanel').hidden;
    $('#advPanel').hidden = !open;
    $('#advBtn').setAttribute('aria-expanded', String(open));
    $('#advBtn').classList.toggle('on', open);
  });
  // 最近：点按钮展开；点菜单外面或按 Esc 收起
  $('#recentBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleRecent(); });
  $('#recentMenu').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-rid]');
    if (item) {
      toggleRecent(false);
      if (state.busy) { showError('正在处理视频，完成后再切换。'); return; }
      try {
        await loadVideo(await openRecent(+item.dataset.rid), { remember: false });
      } catch (err) {
        showError(`找不到这个视频文件（可能已被浏览器清理）：${err.message || err}`);
      }
    } else if (e.target.closest('[data-goto]')) {
      toggleRecent(false);
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) toggleRecent(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleRecent(false); });
  // 自动检查开关
  // 技术细节（抽帧耗时、配置文件、区域参数）默认收起，在「高级」里打开；记在本机浏览器
  let tech = false;
  try { tech = localStorage.getItem('showTech') === '1'; } catch { /* 忽略 */ }
  $('#showTech').checked = tech;
  document.body.classList.toggle('show-tech', tech);
  $('#showTech').addEventListener('change', (e) => {
    document.body.classList.toggle('show-tech', e.target.checked);
    try { localStorage.setItem('showTech', e.target.checked ? '1' : '0'); } catch { /* 忽略 */ }
  });
  $('#autoChecks').checked = autoChecksEnabled();
  $('#autoChecks').addEventListener('change', (e) => setAutoChecks(e.target.checked));
  $('#modeSel').addEventListener('change', renderTimings);
  $('#clearTiming').addEventListener('click', () => { state.timings = []; renderTimings(); });

  // 一级标签；任何带 data-goto 的按钮（“可修复”“查看对比”“去处理”）都能跳转，写法如 data-goto="tech:fix"
  $('#mainTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) goto(b.dataset.tab); });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (!g) return;
    e.preventDefault(); // 按钮在 <summary> 里时，不要顺带展开 / 收起
    goto(g.dataset.goto);
  });

  // 左栏预览：原片 / 处理后；浏览器播不了的格式给出提示
  $('#previewSeg').addEventListener('click', (e) => {
    const src = e.target.dataset.src;
    if (!src) return;
    state.previewSrc = src;
    renderLeft();
  });
  $('#previewVideo').addEventListener('error', () => {
    if (!$('#previewVideo').getAttribute('src')) return;
    $('#previewVideo').hidden = true;
    $('#previewNote').hidden = false;
  });

  // 取消：WebCodecs 转码和 ffmpeg 任务都停掉
  $('#cancelBtn').addEventListener('click', () => {
    state.canceled = true;
    state.conversion?.cancel();
    terminateFFmpeg(); // 终止 worker，正在执行的任务会抛出错误
    showError('已取消当前任务。');
  });
}

/** 挂载外壳：绑定事件，并在状态变化时刷新左栏、标签、平台按钮 */
export function mountShell() {
  bindEvents();
  // 选中块滑动：步骤导航、平台、技术体检的二级标签、预览原片 / 处理后、遮挡和封面里的分段控件
  attachSegSlider($('#mainTabs'), 'button[data-tab]');
  attachSegSlider($('#techTabs'), 'button[data-subtab]');
  ['#platformSeg', '#previewSeg', '#occSrcSeg', '#coverSrcSeg', '#coverEditSeg'].forEach((s) => attachSegSlider($(s), 'button'));
  renderPlatforms();
  renderTimings();
  subscribe((reason) => {
    if (reason === 'config') renderPlatforms();
    renderTabs();
    renderLeft();
  });
  renderTabs();
}
