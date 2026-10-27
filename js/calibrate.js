// ============================================================
// calibrate.js —— 遮挡区域校准页
//
// 用法：载入平台播放页截图 → 在截图上拖出会挡住画面的区域并命名 → 导出 platforms.json。
// 截图只用 URL.createObjectURL 在本机显示，不会上传；
// 未导出的修改自动存在本机浏览器（localStorage，每个平台一份），刷新页面不会丢。
// 坐标一律是相对整张截图的百分比，保留 1 位小数。
// ============================================================
import { loadConfig, validateConfig } from './core/config.js';
import { FULL_AREA, OVERLAY_NOTE, intersect, fitFor, videoRectOnScreen, zonesInVideo } from './lib/overlay-geometry.js';
import { formatConfig, formatSnippet } from './lib/config-format.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const MIN = 1;                                   // 区域最小 1%
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const DRAFT_KEY = (pid) => `calibrate-draft:${pid}`;
const PREVIEW_NAME = { 0.5625: '9:16', 0.75: '3:4', 1: '1:1', 1.7778: '16:9' };

const S = {
  cfg: null,       // 页面打开时读到的配置
  pid: null,       // 当前平台 id
  ov: null,        // 正在编辑的 overlay
  shots: {},       // 每个平台的截图 { url, name, w, h }（只在内存里）
  sel: -1,         // 选中的区域序号
  mode: 'zones',   // zones 编辑遮挡区域 / area 编辑视频播放区域
  preview: 0.5625, // 预览用的视频宽高比
  undo: [],
  drag: null,
  pendingSnap: null,
  restored: false, // 本平台是否从草稿恢复
};

// ---------- 工具 ----------
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 矩形取 1 位小数，并保证不超出截图 */
function fixRect(r) {
  const x = clamp(r1(r.x), 0, 100 - MIN), y = clamp(r1(r.y), 0, 100 - MIN);
  return { x, y, w: clamp(r1(r.w), MIN, r1(100 - x)), h: clamp(r1(r.h), MIN, r1(100 - y)) };
}
const pname = () => S.cfg?.platforms?.[S.pid]?.name || '';
function showError(msg) { $('#errorBox').textContent = msg; $('#errorBox').hidden = !msg; }

/** 配置文件里的 overlay（补全缺省字段） */
function baseOverlay(pid) {
  const o = structuredClone(S.cfg.platforms[pid]?.overlay || {});
  return {
    source: o.source || '',
    screenAspect: o.screenAspect || 0.4615,
    videoArea: { ...(o.videoArea || FULL_AREA) },
    videoFit: o.videoFit || 'contain',
    coverMaxCrop: o.coverMaxCrop,
    zones: (o.zones || []).map((z) => ({ id: z.id, name: z.name, desc: z.desc || '', x: z.x, y: z.y, w: z.w, h: z.h })),
  };
}
/** 用于判断“和配置文件是否一样”（不比较日期和说明） */
const norm = (ov) => JSON.stringify([ov.source, ov.screenAspect, ov.videoArea, ov.videoFit, ov.coverMaxCrop ?? null, ov.zones]);
const isDirty = () => norm(S.ov) !== norm(baseOverlay(S.pid));

// ---------- 草稿（本机浏览器） ----------
function readDraft(pid) {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY(pid)) || 'null'); } catch { return null; }
}
let saveTimer = 0;
function saveDraft() {
  clearTimeout(saveTimer);
  const pid = S.pid, ov = S.ov, dirty = isDirty();
  saveTimer = setTimeout(() => {
    try {
      if (dirty) localStorage.setItem(DRAFT_KEY(pid), JSON.stringify({ ov, savedAt: Date.now() }));
      else localStorage.removeItem(DRAFT_KEY(pid));
    } catch { /* 隐私模式等情况下存不了，不影响使用 */ }
  }, 300);
  renderDraftBar();
}

// ---------- 撤销 ----------
function pushUndo(snap = JSON.stringify(S.ov)) {
  S.undo.push(snap);
  if (S.undo.length > 60) S.undo.shift();
  $('#undoBtn').disabled = false;
}
function undo() {
  if (!S.undo.length) return;
  S.ov = JSON.parse(S.undo.pop());
  if (S.sel >= S.ov.zones.length) S.sel = -1;
  $('#undoBtn').disabled = !S.undo.length;
  renderAll();
  saveDraft();
}

// ============================================================
// 渲染
// ============================================================
const rectStyle = (r) => `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%`;
const handles = () => HANDLES.map((h) => `<i class="hd" data-h="${h}"></i>`).join('');

/** 预览比例的视频在播放区域里的效果，例如“上下留黑边” */
function fitDesc() {
  const area = S.ov.videoArea, v = videoRectOnScreen(S.ov, S.preview), e = 0.2;
  const name = PREVIEW_NAME[S.preview] || '';
  if (fitFor(S.ov, S.preview) === 'cover') {
    if (v.w > area.w + e) return `${name} 视频铺满播放区域，左右各被裁掉约 ${r1(((v.w - area.w) / 2 / v.w) * 100)}% 画面宽度`;
    if (v.h > area.h + e) return `${name} 视频铺满播放区域，上下各被裁掉约 ${r1(((v.h - area.h) / 2 / v.h) * 100)}% 画面高度`;
  } else {
    if (v.h < area.h - e) return `${name} 视频完整显示，上下各留约 ${r1((area.h - v.h) / 2)}% 屏幕高度的黑边`;
    if (v.w < area.w - e) return `${name} 视频完整显示，左右各留约 ${r1((area.w - v.w) / 2)}% 屏幕宽度的黑边`;
  }
  return `${name} 视频正好铺满播放区域`;
}

function renderStage() {
  const ov = S.ov, shot = S.shots[S.pid];
  const stage = $('#stage');
  stage.style.setProperty('--aspect', ov.screenAspect);
  stage.classList.toggle('mode-area', S.mode === 'area');
  const img = $('#shot');
  if (shot) { if (img.getAttribute('src') !== shot.url) img.src = shot.url; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  $('#stageEmpty').hidden = !!shot;

  // 白色点线：预览比例的视频实际显示范围（只画看得到的部分）
  const area = ov.videoArea;
  const v = videoRectOnScreen(ov, S.preview);
  const vis = intersect(v, area) || v;
  let html = `<div class="vbox" style="${rectStyle(vis)}"><span>${PREVIEW_NAME[S.preview] || ''} 视频画面</span></div>`;
  html += `<div class="va" style="${rectStyle(area)}">${S.mode === 'area' ? `<span class="z-name">视频播放区域</span>${handles()}` : ''}</div>`;
  ov.zones.forEach((z, i) => {
    const sel = i === S.sel;
    html += `<div class="z ${sel ? 'sel' : ''}" data-i="${i}" style="${rectStyle(z)}"><span class="z-name">${esc(z.name || '未命名')}</span>${sel && S.mode === 'zones' ? handles() : ''}</div>`;
  });
  $('#layer').innerHTML = html;
  renderFoot();
}

/** 画布下方：选中区域的位置（截图上的像素） */
function renderFoot() {
  const shot = S.shots[S.pid];
  const r = S.mode === 'area' ? S.ov.videoArea : S.ov.zones[S.sel];
  if (!r) { $('#stageFoot').textContent = S.ov.zones.length ? '点一个区域可以选中它' : '在截图上拖动，框出第一个会挡住画面的区域'; return; }
  const name = S.mode === 'area' ? '视频播放区域' : S.ov.zones[S.sel].name || '未命名';
  const px = shot ? `，截图上从 (${Math.round((r.x / 100) * shot.w)}, ${Math.round((r.y / 100) * shot.h)}) 起 ${Math.round((r.w / 100) * shot.w)}×${Math.round((r.h / 100) * shot.h)} 像素` : '';
  $('#stageFoot').textContent = `${name}：x ${r.x}% · y ${r.y}% · 宽 ${r.w}% · 高 ${r.h}%${px}`;
}

function renderPlatforms() {
  $('#platformSeg').innerHTML = Object.entries(S.cfg.platforms).map(([id, p]) =>
    `<button data-pid="${esc(id)}" class="${id === S.pid ? 'on' : ''}">${esc(p.name)}</button>`).join('');
}

function renderShotCard() {
  const shot = S.shots[S.pid];
  $('#shotInfo').textContent = shot
    ? `${shot.name} · ${shot.w}×${shot.h} · 宽高比 ${r1((shot.w / shot.h) * 1000) / 1000}`
    : `未选择截图（按配置里的宽高比 ${S.ov.screenAspect} 显示）`;
}

function renderFitCard() {
  $('#fitSel').value = S.ov.videoFit;
  $('#previewSel').value = String(S.preview);
  const a = S.ov.videoArea;
  const areaText = a.x === 0 && a.y === 0 && a.w === 100 && a.h === 100 ? '播放区域是整个屏幕' : `播放区域：x ${a.x}% · y ${a.y}% · 宽 ${a.w}% · 高 ${a.h}%`;
  $('#fitNote').textContent = `${areaText}。白色点线：${fitDesc()}。`;
}

function renderList() {
  const zs = S.ov.zones;
  $('#zoneList').innerHTML = zs.length
    ? zs.map((z, i) => `<li data-i="${i}" class="${i === S.sel ? 'sel' : ''}"><span class="sw"></span>
        <span class="zl-name">${esc(z.name || '未命名')}</span><span class="hint num">${z.x}, ${z.y} · ${z.w}×${z.h}</span></li>`).join('')
    : '<li class="empty-li">还没有区域，在左边截图上拖动即可新建</li>';
}

/** 选中区域的编辑表单（只在切换选中时重建，避免打字时丢失焦点） */
function renderEditor() {
  const z = S.ov.zones[S.sel];
  if (!z || S.mode !== 'zones') { $('#editor').innerHTML = ''; return; }
  const num = (k, label) => `<label class="field"><span class="label">${label}（%）</span><input type="number" step="0.1" min="0" max="100" data-k="${k}" value="${z[k]}"></label>`;
  $('#editor').innerHTML = `<div class="editor">
      <label class="field"><span class="label">名称（显示给创作者看，例如“底部标题和文案区”）</span><input type="text" data-k="name" value="${esc(z.name)}"></label>
      <label class="field"><span class="label">说明（这里有什么，例如“作者名、标题文案、话题”）</span><textarea data-k="desc">${esc(z.desc)}</textarea></label>
      <div class="grid4">${num('x', '左')}${num('y', '上')}${num('w', '宽')}${num('h', '高')}</div>
      <label class="field"><span class="label">id（英文，程序内部用，不要重复）</span><input type="text" data-k="id" value="${esc(z.id)}"></label>
      <p class="hint" id="inVideo"></p>
      <div class="editor-foot"><span class="hint">方向键微调位置，按住 Shift 每次 1%</span><button class="btn sm" id="delZone">删除这个区域</button></div>
    </div>`;
  syncEditor();
}

/** 拖动时只更新数字，不重建表单 */
function syncEditor() {
  const z = S.ov.zones[S.sel];
  if (!z) return;
  for (const k of ['x', 'y', 'w', 'h']) {
    const inp = document.querySelector(`#editor [data-k="${k}"]`);
    if (inp && document.activeElement !== inp) inp.value = z[k];
  }
  const el = $('#inVideo');
  if (!el) return;
  const m = zonesInVideo(S.ov, S.preview).zones.find((x) => x.id === z.id);
  el.textContent = m
    ? `在 ${PREVIEW_NAME[S.preview]} 视频画面上：x ${r1(m.x)}% · y ${r1(m.y)}% · 宽 ${r1(m.w)}% · 高 ${r1(m.h)}%（画面遮挡检查用这个位置）`
    : `这个区域没有挡到 ${PREVIEW_NAME[S.preview]} 视频画面（只在黑边或屏幕外）`;
}

/** 导出前检查，返回问题列表 */
function exportProblems(merged) {
  // 区域的名称、id 下面单独给出更具体的提示，这里去掉通用的那条
  const p = validateConfig(merged).filter((x) => !x.endsWith('缺少 id 或 name'));
  const ids = new Set();
  S.ov.zones.forEach((z, i) => {
    const at = `第 ${i + 1} 个区域（${z.name || '未命名'}）`;
    if (!String(z.name || '').trim()) p.push(`${at}：请填写名称`);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(z.id || '')) p.push(`${at}：id 只能用英文字母、数字和下划线，并以字母开头`);
    else if (ids.has(z.id)) p.push(`${at}：id「${z.id}」和前面的区域重复`);
    ids.add(z.id);
  });
  if (!S.ov.zones.length) p.push('还没有任何遮挡区域');
  return [...new Set(p)];
}

function buildOverlay() {
  const ov = S.ov;
  return {
    _说明: OVERLAY_NOTE,
    source: ov.source || '',
    date: today(),
    screenAspect: ov.screenAspect,
    videoArea: { ...ov.videoArea },
    videoFit: ov.videoFit,
    coverMaxCrop: ov.coverMaxCrop,
    zones: ov.zones.map((z) => ({ id: z.id, name: z.name, desc: z.desc || '', x: z.x, y: z.y, w: z.w, h: z.h })),
  };
}
function merged(cfg) {
  const m = structuredClone(cfg);
  m.platforms[S.pid].overlay = buildOverlay();
  return m;
}

function renderExport() {
  const inp = $('#sourceInput');
  if (document.activeElement !== inp) inp.value = S.ov.source;
  const probs = exportProblems(merged(S.cfg));
  const notes = [];
  if (/^占位/.test(S.ov.source)) notes.push('来源还写着“占位”，建议写上 App 版本和手机型号，方便以后核对。');
  $('#problems').innerHTML = probs.length
    ? `<ul class="problems">${probs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<p class="ok-line">✓ 格式检查通过，可以导出</p>${notes.map((n) => `<p class="hint">${esc(n)}</p>`).join('')}`;
  $('#downloadBtn').disabled = $('#copyBtn').disabled = probs.length > 0;
  $('#jsonPreview').textContent = formatSnippet('overlay', buildOverlay(), '');
}

function renderDraftBar() {
  const dirty = isDirty();
  $('#draftBar').hidden = !dirty;
  if (dirty) $('#draftText').textContent = S.restored ? '已恢复上次没导出的修改（保存在本机浏览器）' : '有修改还没导出（已自动保存在本机浏览器）';
}

function renderModeHint() {
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('#modeHint').textContent = S.mode === 'area'
    ? '拖动绿色虚线框，调整视频实际显示的范围'
    : '拖动空白处新建；拖框移动，拖角或边调整大小；Delete 删除';
}

function renderAll() {
  renderPlatforms();
  renderModeHint();
  renderStage();
  renderShotCard();
  renderFitCard();
  renderList();
  renderEditor();
  renderExport();
  renderDraftBar();
}

/** 修改后统一刷新（不重建编辑表单） */
function changed({ editor = false } = {}) {
  renderStage();
  renderFitCard();
  renderList();
  if (editor) renderEditor(); else syncEditor();
  renderExport();
  saveDraft();
}

// ============================================================
// 平台 / 截图
// ============================================================
function loadPlatform(pid) {
  S.pid = pid;
  S.sel = -1;
  S.undo = [];
  $('#undoBtn').disabled = true;
  const d = readDraft(pid);
  S.ov = d?.ov ? d.ov : baseOverlay(pid);
  S.restored = !!d?.ov && isDirty();
  if (d?.ov && !S.restored) { try { localStorage.removeItem(DRAFT_KEY(pid)); } catch { /* 忽略 */ } } // 配置文件已经和草稿一样
  $('#aspectNote').hidden = true;
  const url = new URL(location.href);
  url.searchParams.set('p', pid);
  history.replaceState(null, '', url);
  renderAll();
}

function loadShot(file) {
  if (!file || !/^image\//.test(file.type)) { showError('请选择图片文件（PNG / JPG 截图）。'); return; }
  showError('');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const prev = S.shots[S.pid];
    if (prev) URL.revokeObjectURL(prev.url);
    const w = img.naturalWidth, h = img.naturalHeight;
    S.shots[S.pid] = { url, name: file.name || '粘贴的截图', w, h };
    const a = Math.round((w / h) * 10000) / 10000;
    const note = $('#aspectNote');
    note.hidden = true;
    if (Math.abs(a - S.ov.screenAspect) > 0.002) {
      pushUndo();
      if (S.ov.zones.length) {
        note.textContent = `这张截图的宽高比（${a}）和原来的（${S.ov.screenAspect}）不同。区域按百分比原样保留，请对照截图检查位置。`;
        note.hidden = false;
      }
      S.ov.screenAspect = a;
    }
    if (!S.ov.source || /^占位/.test(S.ov.source)) S.ov.source = `校准：${pname()} 播放页截图（${w}×${h}）`;
    renderAll();
    saveDraft();
  };
  img.onerror = () => { URL.revokeObjectURL(url); showError('这张图片打不开，请换一张 PNG / JPG 截图。'); };
  img.src = url;
}

// ============================================================
// 画布上的拖动：新建 / 移动 / 缩放
// ============================================================
function stagePoint(e) {
  const b = $('#stage').getBoundingClientRect();
  return { x: clamp(((e.clientX - b.left) / b.width) * 100, 0, 100), y: clamp(((e.clientY - b.top) / b.height) * 100, 0, 100) };
}

function resizeRect(r0, h, dx, dy) {
  let { x, y, w, h: hh } = r0;
  const R = r0.x + r0.w, B = r0.y + r0.h;
  if (h.includes('w')) { x = clamp(r0.x + dx, 0, R - MIN); w = R - x; }
  if (h.includes('e')) w = clamp(r0.w + dx, MIN, 100 - r0.x);
  if (h.includes('n')) { y = clamp(r0.y + dy, 0, B - MIN); hh = B - y; }
  if (h.includes('s')) hh = clamp(r0.h + dy, MIN, 100 - r0.y);
  return { x, y, w, h: hh };
}

function nextId() {
  const used = new Set(S.ov.zones.map((z) => z.id));
  let k = 1;
  while (used.has(`zone${k}`)) k++;
  return `zone${k}`;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const stage = $('#stage');
  stage.focus({ preventScroll: true });
  const p = stagePoint(e);
  const hd = e.target.closest('.hd');
  const zEl = e.target.closest('.z');
  let drag;
  if (S.mode === 'area') {
    if (!e.target.closest('.va')) return;
    drag = { kind: 'area', op: hd ? hd.dataset.h : 'move', r0: { ...S.ov.videoArea } };
  } else if (zEl) {
    const i = +zEl.dataset.i;
    if (i !== S.sel) { S.sel = i; renderStage(); renderList(); renderEditor(); }
    drag = { kind: 'zone', op: hd ? hd.dataset.h : 'move', r0: { ...S.ov.zones[i] } };
  } else {
    drag = { kind: 'new' };
  }
  S.drag = { ...drag, start: p, snap: JSON.stringify(S.ov), moved: false };
  stage.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e) {
  const d = S.drag;
  if (!d) return;
  const p = stagePoint(e);
  const dx = p.x - d.start.x, dy = p.y - d.start.y;
  if (!d.moved) {
    if (Math.hypot(dx, dy) < 0.4) return; // 防止点击时的手抖
    d.moved = true;
    pushUndo(d.snap);
    if (d.kind === 'new') {
      S.ov.zones.push({ id: nextId(), name: `区域 ${S.ov.zones.length + 1}`, desc: '', x: d.start.x, y: d.start.y, w: MIN, h: MIN });
      S.sel = S.ov.zones.length - 1;
    }
  }
  let r;
  if (d.kind === 'new') {
    r = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.max(Math.abs(dx), MIN), h: Math.max(Math.abs(dy), MIN) };
  } else if (d.op === 'move') {
    r = { ...d.r0, x: clamp(d.r0.x + dx, 0, 100 - d.r0.w), y: clamp(d.r0.y + dy, 0, 100 - d.r0.h) };
  } else {
    r = resizeRect(d.r0, d.op, dx, dy);
  }
  r = fixRect(r);
  if (d.kind === 'area') S.ov.videoArea = r;
  else Object.assign(S.ov.zones[S.sel], r);
  renderStage();
  syncEditor();
  if (d.kind === 'area') renderFitCard();
}

function onPointerUp() {
  const d = S.drag;
  if (!d) return;
  S.drag = null;
  if (!d.moved) {
    // 只是点了一下空白处：取消选中
    if (d.kind === 'new' && S.sel !== -1) { S.sel = -1; changed({ editor: true }); }
    return;
  }
  changed({ editor: d.kind === 'new' });
  if (d.kind === 'new') document.querySelector('#editor [data-k="name"]')?.select();
}

// ============================================================
// 事件
// ============================================================
function bind() {
  const stage = $('#stage');
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);

  $('#platformSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pid]');
    if (b && b.dataset.pid !== S.pid) loadPlatform(b.dataset.pid);
  });
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    S.mode = b.dataset.mode;
    renderModeHint();
    renderStage();
    renderEditor();
  });
  $('#undoBtn').addEventListener('click', undo);
  $('#discardDraft').addEventListener('click', () => {
    if (!confirm(`放弃对 ${pname()} 的所有修改，恢复成配置文件里的数值？`)) return;
    try { localStorage.removeItem(DRAFT_KEY(S.pid)); } catch { /* 忽略 */ }
    pushUndo();
    S.ov = baseOverlay(S.pid);
    S.sel = -1;
    S.restored = false;
    renderAll();
  });

  // 截图：选择 / 拖入 / 粘贴
  $('#pickShot').addEventListener('click', () => $('#shotInput').click());
  $('#shotInput').addEventListener('change', (e) => { loadShot(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) loadShot(f); else showError('请拖入图片文件（PNG / JPG 截图）。');
  });
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); loadShot(f); }
  });

  // 播放区域 / 预览比例
  $('#fitSel').addEventListener('change', (e) => { pushUndo(); S.ov.videoFit = e.target.value; changed(); });
  $('#previewSel').addEventListener('change', (e) => { S.preview = +e.target.value; renderStage(); renderFitCard(); syncEditor(); });

  // 区域列表
  $('#zoneList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    S.sel = +li.dataset.i;
    if (S.mode !== 'zones') { S.mode = 'zones'; renderModeHint(); }
    renderStage(); renderList(); renderEditor();
  });

  // 编辑表单：第一次输入前记一次撤销点
  const editor = $('#editor');
  editor.addEventListener('focusin', () => { S.pendingSnap = JSON.stringify(S.ov); });
  editor.addEventListener('input', (e) => {
    const k = e.target.dataset.k, z = S.ov.zones[S.sel];
    if (!k || !z) return;
    if (S.pendingSnap) { pushUndo(S.pendingSnap); S.pendingSnap = null; }
    if (['x', 'y', 'w', 'h'].includes(k)) {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      Object.assign(z, fixRect({ ...z, [k]: v }));
    } else {
      z[k] = k === 'id' ? e.target.value.trim() : e.target.value;
    }
    changed();
  });
  editor.addEventListener('focusout', (e) => {
    // 数字框离开时显示修正后的值（例如超出范围被限制）
    if (['x', 'y', 'w', 'h'].includes(e.target.dataset?.k)) syncEditor();
  });
  editor.addEventListener('click', (e) => { if (e.target.id === 'delZone') deleteSelected(); });

  // 导出
  $('#sourceInput').addEventListener('focus', () => { S.pendingSnap = JSON.stringify(S.ov); });
  $('#sourceInput').addEventListener('input', (e) => {
    if (S.pendingSnap) { pushUndo(S.pendingSnap); S.pendingSnap = null; }
    S.ov.source = e.target.value;
    renderExport();
    saveDraft();
  });
  $('#downloadBtn').addEventListener('click', download);
  $('#copyBtn').addEventListener('click', copySnippet);

  // 键盘：方向键微调、Delete 删除、Esc 取消选中、⌘Z / Ctrl+Z 撤销
  let lastNudge = 0;
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    const target = S.mode === 'area' ? S.ov.videoArea : S.ov.zones[S.sel];
    if (!target) return;
    const step = e.shiftKey ? 1 : 0.1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) {
      e.preventDefault();
      if (Date.now() - lastNudge > 800) pushUndo(); // 连续按方向键只记一次撤销点
      lastNudge = Date.now();
      Object.assign(target, fixRect({ ...target, x: clamp(target.x + mv[0], 0, 100 - target.w), y: clamp(target.y + mv[1], 0, 100 - target.h) }));
      changed();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.mode === 'zones') {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape') {
      S.sel = -1;
      changed({ editor: true });
    }
  });

  window.addEventListener('beforeunload', () => { Object.values(S.shots).forEach((s) => URL.revokeObjectURL(s.url)); });
}

function deleteSelected() {
  if (S.sel < 0) return;
  pushUndo();
  S.ov.zones.splice(S.sel, 1);
  S.sel = -1;
  changed({ editor: true });
}

// ---------- 导出 ----------
async function download() {
  try {
    // 重新读一次配置文件，避免覆盖掉打开校准页之后对文件的其他修改
    const fresh = await loadConfig();
    if (!fresh.platforms[S.pid]) throw new Error(`配置文件里已经没有平台 ${S.pid}`);
    S.cfg = fresh;
    const m = merged(fresh);
    const probs = exportProblems(m);
    if (probs.length) { renderExport(); return; }
    const blob = new Blob([formatConfig(m)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'platforms.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showError('');
    flash('#downloadBtn', '已下载');
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function copySnippet() {
  const text = formatSnippet('overlay', buildOverlay());
  try {
    await navigator.clipboard.writeText(text);
    flash('#copyBtn', '已复制');
  } catch {
    // 剪贴板不可用时，展开预览让用户手动复制
    $('.json-preview').open = true;
    getSelection().selectAllChildren($('#jsonPreview'));
  }
}

function flash(sel, text) {
  const b = $(sel), old = b.textContent;
  b.textContent = text;
  setTimeout(() => { b.textContent = old; }, 1500);
}

// ---------- 启动 ----------
(async function init() {
  bind();
  try {
    S.cfg = await loadConfig();
  } catch (e) {
    showError(e.message);
    return;
  }
  const want = new URL(location.href).searchParams.get('p');
  loadPlatform(S.cfg.platforms[want] ? want : Object.keys(S.cfg.platforms)[0]);
  // 调试用
  window.__cal = S;
})();
