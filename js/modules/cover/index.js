// ============================================================
// cover/index.js —— 封面适配
//
// 流程：从视频里选一帧，或上传一张图片 → 用户框出主体（默认在正中）
//   → 按当前平台的每种封面比例裁切（默认取最大范围、对准主体中心，可拖动调整）
//   → 识别封面上的标题文字（Tesseract.js，和画面遮挡检查共用），检查主体 / 标题会不会被裁掉、被角标挡住，以及清晰度
//   → 每个比例导出一张图片。
// 比例、导出尺寸、角标位置都在 config/platforms.json 的 cover 里。图片只在本机处理，不会上传。
// ============================================================
import { state, subscribe, notify, currentPlatform, autoChecksEnabled } from '../../core/store.js';
import { $, esc, fmtClock, verdictIcon, setStepBusy } from '../../core/ui.js';
import { openVideo, grabFrame } from '../../lib/frame-sampler.js';
import { intersect } from '../../lib/overlay-geometry.js';
import { ensureOCR, recognizeText } from '../../lib/detectors.js';
import { mergeTextBlocks } from '../occlusion/analyze.js';
import { defaultCrop, clampCrop, zonesFor, checkCrop } from './crop.js';
import { attachBoxEditor, boxHtml } from '../../core/box-editor.js';

export const id = 'cover';
export const title = '封面适配';

// 各比例裁切框的颜色：避开状态色（青 / 蓝 / 紫）、主体框（蓝）、识别文字框（黄）、手动标记（橙）
const COLORS = ['#e0458f', '#e5484d', '#a39e93', '#a26b3a'];
const OCR_SIDE = 1280;        // 识别文字时把封面缩小到长边 1280

const C = {
  mode: 'video',     // video 从视频选一帧 / image 上传图片
  src: null,         // { canvas, url, W, H, kind:'frame'|'image', name }
  t: null,           // 选中的帧时间
  subject: null,     // 主体框（原图像素）
  crops: {},         // `${平台}:${比例 id}` → 用户拖动过的裁切框（原图像素）；没拖过的按默认算
  texts: [],         // 识别到的文字块（原图像素）
  manual: [],        // 手动框选的文字（原图百分比）：识别不到的花字、竖排字等
  editMode: 'subject', // 原图上拖动时调整什么：subject 主体 / text 标记文字
  selMan: -1,
  ocr: 'idle',       // idle / running / done / error
  sampler: null,     // 抽帧用的隐藏 video（openVideo 的返回值）
  samplerUrl: null,
  grabbing: false,
  wantT: null,
};

// ---------- 数据 ----------
const ratios = () => currentPlatform()?.cover?.ratios || [];
const keyOf = (r) => `${state.platform}:${r.id}`;
const pname = () => currentPlatform()?.name || '平台';
/** 封面时间点精确到 0.1 秒：0:03.4 */
const fmtT = (t) => `${fmtClock(t)}.${Math.floor((t * 10) % 10)}`;

function cropOf(r) {
  const m = C.crops[keyOf(r)];
  return m || defaultCrop(C.src.W, C.src.H, r.ratio, C.subject);
}

/** 参与检查的文字：自动识别的 + 手动框选的（换算成原图像素） */
function allTexts() {
  const manual = C.manual.map((m) => ({ kind: 'text', manual: true, x: (m.x / 100) * C.src.W, y: (m.y / 100) * C.src.H, w: (m.w / 100) * C.src.W, h: (m.h / 100) * C.src.H }));
  return [...(C.ocr === 'done' ? C.texts : []), ...manual];
}

/** 每个比例的检查结果 */
function results() {
  if (!C.src) return [];
  return ratios().map((r, i) => {
    const crop = cropOf(r);
    const zones = zonesFor(r, currentPlatform());
    const issues = checkCrop({ W: C.src.W, H: C.src.H, crop, subject: C.subject, texts: allTexts(), ratioCfg: r, zones });
    return { r, i, crop, zones, issues, color: COLORS[i % COLORS.length] };
  });
}

/**
 * 问题列表（右栏和总报告共用）：每个比例的问题前面写上比例名；
 * “清晰度不够”各比例几乎总是一起出现，合并成一条，免得刷屏
 */
function mergedIssues(list) {
  const out = [];
  const blurry = [];
  list.forEach(({ r, issues }) => issues.forEach((it) => {
    if (it.kind === 'resolution') blurry.push({ r, it });
    else out.push({ ...it, title: `${r.name}（${r.ratio.join(':')}）：${it.title}` });
  }));
  if (blurry.length) {
    const by = blurry.map(({ r, it }) => `${r.ratio.join(':')} 要放大 ${(it.scale || 0).toFixed(1)} 倍`).join('，');
    out.push({
      kind: 'resolution', title: `清晰度不够（${by}）`,
      reason: `${C.mode === 'video' ? '截取的视频画面' : '这张图'}只有 ${C.src.W}×${C.src.H}，按平台尺寸导出时要放大，会有点糊。`,
      suggestion: C.mode === 'video' ? '上传做好的高清封面图（点上方「上传图片」），或从更高清的原视频里截帧。' : '换一张更清晰的原图。',
    });
  }
  return out;
}

/** 总报告用：还没选封面或文字还在识别时返回 null（显示“尚未检查”） */
export function getReportItems() {
  if (!C.src || C.ocr === 'running' || C.ocr === 'idle') return null;
  const list = results();
  const items = mergedIssues(list).map((it) => ({
    module: id, moduleName: title, status: 'warn', title: it.title, value: '',
    reason: it.reason, suggestion: it.suggestion, fixable: false, goto: 'cover',
  }));
  if (items.length) return items;
  return [{
    module: id, moduleName: title, status: 'pass', title: '封面在各个比例下都没问题', value: list.map(({ r }) => r.ratio.join(':')).join(' / '),
    reason: '主体和标题文字都没有被裁掉或被角标挡住，清晰度也够。', suggestion: '', fixable: false, goto: 'cover',
  }];
}

// ============================================================
// 封面来源：视频帧 / 图片
// ============================================================
/** 默认主体框：各比例居中裁切后都能看到的范围，再缩小到 70%（保证一开始在每个比例里都放得下） */
function defaultSubject(W, H) {
  let box = { x: 0, y: 0, w: W, h: H };
  for (const r of ratios()) box = intersect(box, defaultCrop(W, H, r.ratio, null)) || box;
  const w = box.w * 0.7, h = box.h * 0.7;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** 设置新的封面原图 */
function setSource(canvas, kind, name) {
  const old = C.src;
  const sameSize = old && old.W === canvas.width && old.H === canvas.height;
  if (old?.url) URL.revokeObjectURL(old.url);
  C.src = { canvas, W: canvas.width, H: canvas.height, kind, name, url: null };
  if (!sameSize) {
    // 尺寸变了：主体框回到正中，手动调整过的裁切作废
    C.subject = defaultSubject(C.src.W, C.src.H);
    C.crops = {};
    C.manual = []; // 换了另一张图：手动框作废（同一个视频换帧时保留，标题通常还在原处）
    C.selMan = -1;
  }
  C.texts = [];
  C.ocr = 'idle';
  canvas.toBlob((b) => {
    if (C.src?.canvas !== canvas) return;
    C.src.url = URL.createObjectURL(b);
    renderAll();
  }, 'image/png');
  scheduleOCR();
}

/** 从视频取一帧（拖动滑块时只保留最新的请求，避免排队） */
async function grabAt(t) {
  C.wantT = t;
  if (C.grabbing) return;
  C.grabbing = true;
  setStepBusy('cover', true);
  try {
    const o = state.original;
    if (!o?.file) return;
    if (!o.url) o.url = URL.createObjectURL(o.file);
    if (!C.sampler || C.samplerUrl !== o.url) {
      closeSampler();
      C.sampler = await openVideo(o.url);
      C.samplerUrl = o.url;
      $('#coverTime').max = C.sampler.duration;
    }
    while (C.wantT != null) {
      const want = C.wantT;
      C.wantT = null;
      const canvas = await grabFrame(C.sampler, want);
      if (C.mode !== 'video') return; // 取帧期间用户换成了上传图片：丢掉这一帧
      C.t = want;
      setSource(canvas, 'frame', o.file.name);
    }
  } catch (e) {
    console.error(e);
    $('#coverVerdict').innerHTML = `<p class="occ-frame-msg bad">取不到视频画面：${esc(e.message || e)}</p>`;
  } finally {
    C.grabbing = false;
    setStepBusy('cover', !!C.src && C.ocr === 'idle'); // 取好帧后半秒会接着识别标题文字，转圈不停
  }
}

function closeSampler() {
  if (C.sampler) C.sampler.video.removeAttribute('src');
  C.sampler = null;
  C.samplerUrl = null;
}

/** 载入上传的图片（按照片里记录的方向自动旋转） */
async function loadImage(file) {
  if (!file?.type?.startsWith('image/')) return;
  C.mode = 'image'; // 先切过去，避免正在取的视频帧把图片盖掉
  C.wantT = null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    $('#coverImageName').textContent = file.name;
    setSource(c, 'image', file.name);
  } catch (e) {
    alert(`这张图片打不开：${e.message || e}`);
  }
}

// ---------- 标题文字识别 ----------
let ocrTimer = 0, ocrToken = 0;
function scheduleOCR() {
  clearTimeout(ocrTimer);
  ocrTimer = setTimeout(runOCR, 500); // 拖动滑块停下来半秒后再识别
}
async function runOCR() {
  if (!C.src) return;
  const token = ++ocrToken;
  const src = C.src;
  C.ocr = 'running';
  setStepBusy('cover', true);
  renderSide();
  try {
    const scale = Math.min(1, OCR_SIDE / Math.max(src.W, src.H));
    const c = document.createElement('canvas');
    c.width = Math.round(src.W * scale);
    c.height = Math.round(src.H * scale);
    c.getContext('2d').drawImage(src.canvas, 0, 0, c.width, c.height);
    await ensureOCR(1);
    // 画面遮挡检查正在跑时要排队；用户在那边点“取消”会释放识别线程，所以设个超时（最多等 90 秒）
    const lines = await Promise.race([recognizeText(c), new Promise((_, rej) => setTimeout(() => rej(new Error('文字识别超时')), 90_000))]);
    if (token !== ocrToken || C.src !== src) return; // 已经换了封面
    const px = lines.map((l) => ({ kind: 'text', text: l.text, x: l.x / scale, y: l.y / scale, w: l.w / scale, h: l.h / scale }));
    C.texts = mergeTextBlocks(px);
    C.ocr = 'done';
  } catch (e) {
    if (token !== ocrToken) return;
    console.warn('封面文字识别失败：', e);
    C.texts = [];
    C.ocr = 'error';
  }
  setStepBusy('cover', false);
  renderAll();
  notify('cover');
}

// ============================================================
// 渲染
// ============================================================
const pctRect = (b) => `left:${(b.x / C.src.W) * 100}%;top:${(b.y / C.src.H) * 100}%;width:${(b.w / C.src.W) * 100}%;height:${(b.h / C.src.H) * 100}%`;

/** 左：原图 + 主体框 + 各比例裁切范围 + 文字框 */
function renderEditor() {
  const ed = $('#coverEditor');
  if (!C.src) { $('#coverLayer').innerHTML = ''; $('#coverImg').removeAttribute('src'); renderManual(); return; }
  ed.style.setProperty('--ca', C.src.W / C.src.H);
  if (C.src.url && $('#coverImg').getAttribute('src') !== C.src.url) $('#coverImg').src = C.src.url;
  const list = results();
  let html = list.map(({ r, crop, color }) => `<div class="cv-crop" style="${pctRect(crop)};--c:${color}"><span>${esc(r.ratio.join(':'))}</span></div>`).join('');
  html += (C.ocr === 'done' ? C.texts : []).map((t) => `<div class="cv-text" style="${pctRect(t)}"></div>`).join('');
  // 调整主体时，手动框只显示不能编辑（编辑在 #coverManual 图层里）
  if (C.editMode !== 'text') html += C.manual.map((b, i) => `<div class="mb static" style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%"><span>标记 ${i + 1}</span></div>`).join('');
  html += `<div class="cv-subject" style="${pctRect(C.subject)}"><span>主体</span>${['nw', 'ne', 'se', 'sw'].map((h) => `<i class="hd" data-h="${h}"></i>`).join('')}</div>`;
  $('#coverLayer').innerHTML = html;
  renderManual();
}

/** 标记文字图层（只在“标记文字”模式下可编辑） */
function renderManual() {
  const layer = $('#coverManual');
  layer.classList.toggle('on', C.editMode === 'text' && !!C.src);
  layer.innerHTML = C.editMode === 'text' && C.src ? C.manual.map((b, i) => boxHtml(b, i, { selected: i === C.selMan, label: `标记 ${i + 1}` })).join('') : '';
  document.querySelectorAll('#coverEditSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === C.editMode));
  $('#coverEditHint').innerHTML = C.editMode === 'text'
    ? '在原图上拖动，框出<b>识别不到的重要文字</b>（花字、竖排字、半透明字等）；选中后可拖动、拖角调整，点 × 删除。'
    : '蓝色框是<b>主体</b>（最重要的部分），拖动、拖角调整；彩色虚线是各比例的裁切范围（颜色和下方预览卡片对应），黄色细框是识别到的文字，橙色框是手动标记的文字。';
}

/** 右：结论和问题列表 */
function renderSide() {
  if (!C.src) { $('#coverVerdict').innerHTML = ''; $('#coverIssues').innerHTML = ''; return; }
  const list = results();
  const issues = mergedIssues(list);
  const n = issues.length;
  const ocrNote = C.ocr === 'running' || C.ocr === 'idle' ? '正在识别封面上的标题文字…' : C.ocr === 'error' ? '标题文字识别失败，只检查了主体和清晰度。' : (C.texts.length ? `识别到 ${C.texts.length} 处标题文字（黄框）。` : '封面上没有识别到文字。') + (C.manual.length ? ` 另有 ${C.manual.length} 处手动标记（橙框）。` : C.texts.length ? '' : '如果有重要文字没认出来，可以切到「标记文字」手动框出。');
  $('#coverVerdict').innerHTML = `<div class="verdict-title">${verdictIcon(n ? 'warn' : 'pass')}${n
    ? `发现 ${n} 处需要注意`
    : `${list.length} 个比例都没问题`}</div><div class="hint">${esc(ocrNote)} 按 ${esc(pname())} 的 ${list.map(({ r }) => r.ratio.join(':')).join('、')} 检查。</div>`;
  $('#coverIssues').innerHTML = issues.map((it) => `<li>
      <span class="ev-title">${esc(it.title)}</span><span>${esc(it.reason)}</span>
      <span class="ev-sug"><b>建议：</b>${esc(it.suggestion)}</span></li>`).join('');
  $('#countCover').textContent = n || '';
  $('#countCover').className = `count ${n ? 'warn' : ''}`;
}

/** 下：每个比例的预览卡片 */
function renderCrops() {
  if (!C.src) { $('#coverCrops').innerHTML = ''; return; }
  $('#coverCrops').innerHTML = results().map(({ r, crop, zones, issues, color }) => `
    <div class="crop-card ${issues.length ? 'bad' : ''}" data-rid="${esc(r.id)}">
      <div class="crop-card-head"><b style="color:${color}">${esc(r.name)}</b><span class="tag">${esc(r.ratio.join(':'))}</span><span class="hint">${esc(r.desc || '')}</span></div>
      <div class="crop-view" data-rid="${esc(r.id)}" style="aspect-ratio:${r.ratio[0]}/${r.ratio[1]}">
        <img src="${esc(C.src.url || '')}" alt="" style="${imgStyle(crop)}">
        ${zones.map((z) => `<div class="cz" style="left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%"><span>${esc(z.name)}</span></div>`).join('')}
      </div>
      <div class="c-status ${issues.length ? 'bad' : 'ok'}">${issues.length ? `${issues.length} 处需要注意：${esc(issues[0].title)}` : '✓ 没问题'}</div>
      <div class="hint num">导出 ${r.size.join('×')}</div>
      <div class="actions"><button class="btn sm" data-act="download" data-rid="${esc(r.id)}">下载</button>
        ${C.crops[keyOf(r)] ? `<button class="btn ghost sm" data-act="reset" data-rid="${esc(r.id)}">重置位置</button>` : ''}</div>
    </div>`).join('');
}

/** 预览里原图的摆放：裁切框正好铺满预览框 */
const imgStyle = (c) => `width:${(C.src.W / c.w) * 100}%;height:${(C.src.H / c.h) * 100}%;left:${(-c.x / c.w) * 100}%;top:${(-c.y / c.h) * 100}%`;

function renderSourceBar() {
  const hasVideo = !!state.original?.info;
  if (!hasVideo && C.mode === 'video') C.mode = 'image';
  document.querySelectorAll('#coverSrcSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.src === C.mode);
    if (b.dataset.src === 'video') b.disabled = !hasVideo;
  });
  $('#coverSrcVideo').hidden = C.mode !== 'video';
  $('#coverSrcImage').hidden = C.mode !== 'image';
  const dur = C.sampler?.duration || state.original?.info?.durationSec || 0;
  if (dur) $('#coverTime').max = dur;
  if (C.t != null && document.activeElement !== $('#coverTime')) $('#coverTime').value = C.t;
  $('#coverTimeText').textContent = `${fmtT(+$('#coverTime').value)}${dur ? ` / ${fmtClock(dur)}` : ''}`;
}

function renderConfig() {
  const cv = currentPlatform()?.cover;
  $('#coverConfig').innerHTML = cv?.ratios?.length
    ? `<ul class="zone-list">${cv.ratios.map((r) => `<li><b>${esc(r.name)} ${esc(r.ratio.join(':'))}</b><span class="hint">${esc(r.desc || '')} · 导出 ${esc(r.size.join('×'))}</span>
        <span class="hint">角标：${r.zonesFrom === 'overlay' ? '用播放页的界面遮挡区域' : (r.zones || []).map((z) => `${esc(z.name)}（x ${z.x}% · y ${z.y}% · 宽 ${z.w}% · 高 ${z.h}%）`).join('、') || '无'}</span></li>`).join('')}</ul>
      <p class="hint">来源：${esc(cv.source || '未注明')}（${esc(cv.date || '')}）</p>`
    : '<p class="hint">当前平台还没有配置封面比例（config/platforms.json 的 cover）。</p>';
}

function renderAll() {
  const has = !!state.original?.info || !!C.src;
  $('#coverEmpty').hidden = has;
  $('#coverBody').hidden = !has;
  document.querySelectorAll('.cover-pname').forEach((el) => { el.textContent = pname(); });
  if (!has) { $('#countCover').textContent = ''; return; }
  renderSourceBar();
  renderEditor();
  renderSide();
  renderCrops();
  renderConfig();
}

/** 自动取视频 10% 处的一帧：打开这个标签时，或导入视频后（开了“自动检查”）在后台取好 */
function ensureDefaultFrame() {
  if (C.src || C.grabbing || C.mode !== 'video' || !state.original?.info || state.busy) return;
  if (state.tab !== 'cover' && !autoChecksEnabled()) return;
  const dur = state.original.info.durationSec || 0;
  grabAt(Math.round(dur * 0.1 * 100) / 100);
}

// ============================================================
// 交互：主体框拖动、预览拖动、导出
// ============================================================
let drag = null;
function editorPoint(e) {
  const b = $('#coverEditor').getBoundingClientRect();
  return { x: ((e.clientX - b.left) / b.width) * C.src.W, y: ((e.clientY - b.top) / b.height) * C.src.H };
}
function onEditorDown(e) {
  if (!C.src || e.button !== 0 || C.editMode === 'text') return;
  const p = editorPoint(e);
  const hd = e.target.closest('.hd'), box = e.target.closest('.cv-subject');
  drag = { kind: 'subject', op: hd ? hd.dataset.h : box ? 'move' : 'new', start: p, s0: { ...C.subject } };
  $('#coverEditor').setPointerCapture(e.pointerId);
  e.preventDefault();
}
function onEditorMove(e) {
  if (!drag || drag.kind !== 'subject') return;
  const p = editorPoint(e), W = C.src.W, H = C.src.H, MIN = Math.min(W, H) * 0.04;
  const dx = p.x - drag.start.x, dy = p.y - drag.start.y, s0 = drag.s0;
  let s;
  if (drag.op === 'move') {
    s = { ...s0, x: Math.min(Math.max(0, s0.x + dx), W - s0.w), y: Math.min(Math.max(0, s0.y + dy), H - s0.h) };
  } else if (drag.op === 'new') {
    if (Math.hypot(dx, dy) < MIN / 2) return;
    s = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.max(Math.abs(dx), MIN), h: Math.max(Math.abs(dy), MIN) };
  } else {
    const R = s0.x + s0.w, B = s0.y + s0.h;
    let { x, y, w, h } = s0;
    if (drag.op.includes('w')) { x = Math.min(Math.max(0, s0.x + dx), R - MIN); w = R - x; }
    if (drag.op.includes('e')) w = Math.min(Math.max(MIN, s0.w + dx), W - s0.x);
    if (drag.op.includes('n')) { y = Math.min(Math.max(0, s0.y + dy), B - MIN); h = B - y; }
    if (drag.op.includes('s')) h = Math.min(Math.max(MIN, s0.h + dy), H - s0.y);
    s = { x, y, w, h };
  }
  C.subject = s;
  renderEditor();
  renderCrops();
}
function onEditorUp() {
  if (drag?.kind !== 'subject') return;
  drag = null;
  renderAll();
  notify('cover');
}

/** 拖动预览图：移动这个比例的裁切位置 */
function onCropDown(e) {
  const view = e.target.closest('.crop-view');
  if (!view || !C.src || e.button !== 0) return;
  const r = ratios().find((x) => x.id === view.dataset.rid);
  drag = { kind: 'crop', r, view, start: { x: e.clientX, y: e.clientY }, c0: { ...cropOf(r) }, w: view.getBoundingClientRect().width };
  view.setPointerCapture(e.pointerId);
  e.preventDefault();
}
function onCropMove(e) {
  if (drag?.kind !== 'crop') return;
  const { r, view, start, c0, w } = drag;
  const k = c0.w / w; // 预览上 1 像素 = 原图上 k 像素；往右拖图 = 裁切框往左移
  const c = clampCrop({ ...c0, x: c0.x - (e.clientX - start.x) * k, y: c0.y - (e.clientY - start.y) * k }, C.src.W, C.src.H);
  C.crops[keyOf(r)] = c;
  view.querySelector('img').style.cssText = imgStyle(c);
  renderEditor();
}
function onCropUp() {
  if (drag?.kind !== 'crop') return;
  drag = null;
  renderAll();
  notify('cover');
}

/** 导出一个比例 */
function exportRatio(r) {
  const crop = cropOf(r);
  const [w, h] = r.size;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(C.src.canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  const fmt = $('#coverFormat').value;
  const base = (C.src.name || '封面').replace(/\.[^.]+$/, '');
  const at = C.src.kind === 'frame' && C.t != null ? `_${Math.round(C.t * 10) / 10}s` : '';
  return new Promise((resolve) => c.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${base}${at}_${pname()}_${r.name}_${w}x${h}.${fmt === 'png' ? 'png' : 'jpg'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    resolve();
  }, `image/${fmt}`, 0.92));
}

function reset() {
  closeSampler();
  if (C.src?.kind === 'frame') {
    if (C.src.url) URL.revokeObjectURL(C.src.url);
    C.src = null;
    C.texts = [];
    C.ocr = 'idle';
    C.crops = {};
    C.manual = [];
    C.selMan = -1;
  }
  C.t = null;
  if (C.src?.kind !== 'image' && C.mode !== 'image') C.mode = 'video';
}

// ============================================================
// 挂载
// ============================================================
export function mount() {
  const ed = $('#coverEditor');
  ed.addEventListener('pointerdown', onEditorDown);
  ed.addEventListener('pointermove', onEditorMove);
  ed.addEventListener('pointerup', onEditorUp);
  ed.addEventListener('pointercancel', onEditorUp);
  attachBoxEditor($('#coverManual'), {
    enabled: () => C.editMode === 'text' && !!C.src,
    get: () => C.manual,
    select: (i) => { C.selMan = i; },
    set: (list, final) => {
      C.manual = list;
      if (final) { renderAll(); notify('cover'); } else { renderManual(); renderCrops(); renderSide(); }
    },
  });
  $('#coverManual').addEventListener('click', (e) => {
    const del = e.target.closest('[data-mb-del]');
    if (!del) return;
    C.manual.splice(+del.dataset.mbDel, 1);
    C.selMan = -1;
    renderAll();
    notify('cover');
  });
  $('#coverEditSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    C.editMode = b.dataset.mode;
    C.selMan = -1;
    renderEditor();
  });
  const crops = $('#coverCrops');
  crops.addEventListener('pointerdown', onCropDown);
  crops.addEventListener('pointermove', onCropMove);
  crops.addEventListener('pointerup', onCropUp);
  crops.addEventListener('pointercancel', onCropUp);
  crops.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const r = ratios().find((x) => x.id === b.dataset.rid);
    if (b.dataset.act === 'download') await exportRatio(r);
    if (b.dataset.act === 'reset') { delete C.crops[keyOf(r)]; renderAll(); notify('cover'); }
  });
  $('#coverExportAll').addEventListener('click', async () => {
    for (const r of ratios()) { await exportRatio(r); await new Promise((ok) => setTimeout(ok, 300)); } // 间隔一下，避免浏览器拦截连续下载
  });

  $('#coverSrcSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b || b.disabled) return;
    C.mode = b.dataset.src;
    renderSourceBar();
    if (C.mode === 'video' && (C.src?.kind !== 'frame')) grabAt(C.t ?? (state.original?.info?.durationSec || 0) * 0.1);
    if (C.mode === 'image' && C.src?.kind !== 'image') $('#coverFile').click();
  });
  $('#coverTime').addEventListener('input', (e) => { $('#coverTimeText').textContent = fmtT(+e.target.value); grabAt(+e.target.value); });
  $('#coverStep').addEventListener('click', () => {
    const fps = state.original?.info?.frameRate || 30;
    const t = Math.min((C.t ?? 0) + 1 / fps, (C.sampler?.duration || 1e9) - 0.01);
    $('#coverTime').value = t;
    grabAt(t);
  });
  const pick = () => $('#coverFile').click();
  $('#coverUpload').addEventListener('click', pick);
  $('#coverUploadEmpty').addEventListener('click', pick);
  $('#coverFile').addEventListener('change', (e) => { loadImage(e.target.files[0]); e.target.value = ''; });

  subscribe((reason) => {
    if (reason === 'before-new-file') reset();
    if (reason === 'cover-image' && state.coverImage) { const f = state.coverImage; state.coverImage = null; loadImage(f); }
    if (reason === 'cover') return; // 自己发出的通知
    if (['config', 'platform', 'analyzed', 'nav', 'before-new-file', 'cover-image', 'busy'].includes(reason)) {
      renderAll();
      ensureDefaultFrame();
    }
  });
  renderAll();
}
