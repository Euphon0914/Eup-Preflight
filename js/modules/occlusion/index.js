// ============================================================
// occlusion/index.js —— 画面遮挡检查
//
// 流程：按平台播放页的样子把视频摆进手机框 → 每隔 N 秒抽一帧（video + canvas，缩小到长边 960）
//   → Tesseract.js 识别字幕和文字 → 和平台界面区域比较重叠面积（analyze.js）。
// （人脸检测按产品决定不做：人脸基本都在画面中间，一眼能看出来）
// 识别结果按“视频画面百分比”保存，切换平台、调整阈值时直接重新判定，不用重新识别。
// 全部在本机进行，视频不会上传。
// ============================================================
import { state, subscribe, notify, currentPlatform, autoChecksEnabled } from '../../core/store.js';
import { $, esc, fmtClock, addTiming } from '../../core/ui.js';
import { FULL_AREA, videoRectOnScreen } from '../../lib/overlay-geometry.js';
import { openVideo, sampleTimes, sampleFrames } from '../../lib/frame-sampler.js';
import { ensureOCR, disposeOCR, recognizeText, suggestedOcrWorkers } from '../../lib/detectors.js';
import { analyzeFrames, describeEvent, fmtAt } from './analyze.js';
import { attachBoxEditor, boxHtml } from '../../core/box-editor.js';

export const id = 'occlusion';
export const title = '画面遮挡检查';

const MAX_SIDE = 960;           // 抽帧画布长边（竖屏 1080×1920 → 540×960）
const EST_OCR_SEC = 1.2;        // 估算用：每帧文字识别约 1.2 秒（单线程、原图 + 亮字遮罩两遍；实测 3 线程平均 0.25~0.45 秒）

const S = {
  src: 'original',   // 检查哪个版本：original / fixed
  interval: 1,
  th: 0.3,
  previewOnly: false,
  showZones: true,
  running: false,
  cancel: false,
  result: null,      // { src, url, aspect, duration, interval, frames, stats, checked }
  phoneKey: '',      // 手机框对应的视频 + 平台，变了才重建
  aspect: null,      // 当前预览视频的宽高比
  selKey: null,      // 选中的问题
  lastFrameT: null,  // 当前显示识别框的帧
  manual: [],        // 手动框选的文字 [{ x, y, w, h, start, end }]（视频画面百分比；start / end 为出现的时间段，秒）
  marking: false,    // 是否在框选模式
  selMan: -1,        // 选中的手动框
  autoPending: false, // 新视频分析完后，等技术体检空闲下来自动检查一次
};

const AUTO_MAX_SEC = 600; // 自动检查只对 10 分钟以内的视频做，更长的手动点“开始检查”

const MANUAL_LABEL = '标记文字';

// ---------- 数据 ----------
function slotOf(src) {
  const s = src === 'fixed' && state.fixed?.info ? state.fixed : state.original;
  if (s?.file && !s.url) s.url = URL.createObjectURL(s.file); // 左栏预览也用这个地址（换视频时统一释放）
  return s;
}
const pname = () => currentPlatform()?.name || '平台';

/** 视频时长（有的文件头里没写，就用识别结果或参数里的） */
function duration() {
  const v = video();
  return S.result?.duration || (v && Number.isFinite(v.duration) ? v.duration : 0) || slotOf(S.src)?.info?.durationSec || 0;
}

/**
 * 用当前平台、当前阈值判定：自动识别的文字 + 手动框选的文字（在各自时间段内的抽帧里都算一处文字）。
 * 没做自动识别、只有手动框时，按抽帧间隔生成时间点，只检查手动框。结果按参数缓存。
 */
let memo = { key: '', val: null };
function analysis() {
  const r = S.result, ov = currentPlatform()?.overlay;
  if (!ov || (!r && !S.manual.length)) return null;
  const interval = r?.interval || S.interval;
  const key = [r?.id, JSON.stringify(S.manual), S.th, state.platform, S.aspect, interval, duration()].join('|');
  if (memo.key === key) return memo.val;
  const manualAt = (t) => S.manual.filter((m) => t >= m.start - 0.001 && t <= m.end + 0.001)
    .map((m) => ({ kind: 'text', label: MANUAL_LABEL, manual: true, x: m.x, y: m.y, w: m.w, h: m.h }));
  const base = r ? r.frames : sampleTimes(duration(), interval).map((t) => ({ t, items: [] }));
  const frames = base.map((f) => ({ t: f.t, items: [...f.items, ...manualAt(f.t)] }));
  memo = { key, val: { ...analyzeFrames(frames, ov, r?.aspect || S.aspect || 9 / 16, S.th, interval), frames, interval } };
  return memo.val;
}

/** 总报告用 */
export function getReportItems() {
  const a = analysis();
  if (!a) return null;
  const moduleName = S.src === 'fixed' ? '画面遮挡检查（处理后）' : '画面遮挡检查';
  if (!a.events.length) {
    return [{
      module: id, moduleName, status: 'pass', title: '字幕和文字都没有被挡住',
      value: S.result ? `检查了 ${S.result.frames.length} 帧` : `手动标记了 ${S.manual.length} 处`,
      reason: S.result ? `按${pname()}播放页的界面位置检查，没有发现被挡住或被裁掉的地方。` : '只检查了手动标记的文字，还没有做自动识别。',
      suggestion: '', fixable: false, goto: 'occlusion',
    }];
  }
  return a.events.map((ev) => {
    const d = describeEvent(ev, pname());
    return {
      module: id, moduleName, status: 'warn', title: d.title, value: `${ev.crop ? '裁掉' : '挡住'} ${Math.round(ev.ratio * 100)}%`,
      reason: d.reason, suggestion: d.suggestion, fixable: false, goto: `occlusion:${ev.worst.t}`,
    };
  });
}

// ============================================================
// 手机框预览：视频按平台的播放区域和摆放方式放进去，上面叠界面区域和识别框
// ============================================================
const rectStyle = (r) => `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%`;
const video = () => $('#occVideo');

function buildPhone() {
  const slot = slotOf(S.src), ov = currentPlatform()?.overlay;
  const key = `${slot?.url}|${state.platform}`;
  if (!slot?.url || !ov) { $('#occPhoneWrap').innerHTML = ''; S.phoneKey = ''; return; }
  if (key === S.phoneKey) { layoutPhone(); return; }
  S.phoneKey = key;
  S.aspect = null;
  $('#occPhoneWrap').innerHTML = `<div class="occ-phone" id="occPhone">
      <div class="occ-area" id="occArea"><div class="occ-video" id="occVideoBox">
        <video id="occVideo" playsinline preload="metadata" src="${esc(slot.url)}"></video>
        <div class="occ-boxes" id="occBoxes"></div>
        <div class="occ-manual" id="occManual"></div>
      </div></div>
      <div class="occ-zl" id="occZoneLayer"></div>
    </div>`;
  const v = video();
  v.addEventListener('loadedmetadata', () => { S.aspect = v.videoWidth / v.videoHeight; layoutPhone(); renderAll(); });
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('seeked', onTime);
  v.addEventListener('play', () => { $('#occPlay').textContent = '暂停'; });
  v.addEventListener('pause', () => { $('#occPlay').textContent = '播放'; });
  v.addEventListener('click', togglePlay);
  attachBoxEditor($('#occManual'), {
    enabled: () => S.marking,
    get: () => S.manual,
    select: (i) => { S.selMan = i; },
    set: (list, final) => {
      const dur = duration();
      S.manual = list.map((b) => ({ start: 0, end: Math.round(dur * 10) / 10, ...b })); // 新框默认整段视频
      renderManual();
      if (final) { renderManualList(); renderResults(); notify('update'); }
    },
  });
  $('#occManual').addEventListener('click', (e) => {
    const del = e.target.closest('[data-mb-del]');
    if (del) removeManual(+del.dataset.mbDel);
  });
  layoutPhone();
  renderManual();
}

function layoutPhone() {
  const ov = currentPlatform()?.overlay, phone = $('#occPhone');
  if (!phone || !ov) return;
  phone.style.setProperty('--sa', ov.screenAspect || 9 / 19.5);
  const a = ov.videoArea || FULL_AREA;
  $('#occArea').style.cssText = rectStyle(a);
  const aspect = S.aspect || 9 / 16; // 视频元数据读到之前先按 9:16 摆
  const v = videoRectOnScreen(ov, aspect);
  // 视频框相对播放区域的位置
  $('#occVideoBox').style.cssText = rectStyle({ x: ((v.x - a.x) / a.w) * 100, y: ((v.y - a.y) / a.h) * 100, w: (v.w / a.w) * 100, h: (v.h / a.h) * 100 });
  renderZoneLayer();
}

/** 界面区域（屏幕百分比）；当前帧有问题的区域标红 */
function renderZoneLayer(hitZones = new Set()) {
  const layer = $('#occZoneLayer'), ov = currentPlatform()?.overlay;
  if (!layer || !ov) return;
  layer.className = `occ-zl${S.previewOnly ? ' mock' : ''}`;
  layer.hidden = !S.showZones && !S.previewOnly;
  layer.innerHTML = (ov.zones || []).map((z) =>
    `<div class="oz ${hitZones.has(z.id) ? 'hit' : ''}" style="${rectStyle(z)}"><span>${esc(z.name)}</span></div>`).join('');
}

/** 找离当前播放时间最近的抽帧（在半个间隔以内） */
function frameAt(t) {
  const a = analysis();
  if (!a) return null;
  let best = null;
  for (const f of a.frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best && Math.abs(best.t - t) <= a.interval / 2 + 0.05 ? best : null;
}

/** 播放 / 跳转时：画出这一帧的识别框和问题说明 */
function onTime() {
  const v = video();
  if (!v) return;
  const dur = duration();
  $('#occTime').textContent = `${fmtClock(v.currentTime)} / ${fmtClock(dur)}`;
  if (dur) $('#occHead').style.left = `${Math.min(100, (v.currentTime / dur) * 100)}%`;
  const f = S.previewOnly || S.marking ? null : frameAt(v.currentTime);
  if (f?.t === S.lastFrameT && f) return;
  S.lastFrameT = f?.t ?? null;
  drawFrame(f);
}

function drawFrame(f) {
  const boxes = $('#occBoxes'), msg = $('#occFrameMsg');
  if (!boxes) return;
  if (!f) {
    boxes.innerHTML = '';
    renderZoneLayer();
    msg.className = 'occ-frame-msg';
    msg.innerHTML = S.previewOnly
      ? '<p>正在预览：灰色区域是平台界面会盖住的地方。播放视频，看字幕和文字有没有被挡住。</p>'
      : S.marking
        ? '<p>在视频画面上拖动，框出没识别到的重要文字（花字、竖排字、半透明字等）。选中后可以拖动、拖角调整，点 × 删除。框好的文字默认整段视频都检查，可以在下面改时间段。</p>'
        : '';
    return;
  }
  const a = analysis();
  const hits = a.hits.filter((h) => h.t === f.t);
  const bad = new Set(hits.map((h) => h.item));
  const items = f.blocks || f.items; // 合并后的文字块（见 analyze.js）
  boxes.innerHTML = items.map((it) =>
    `<div class="ob ${bad.has(it) ? 'bad' : ''} ${it.manual ? 'manual' : ''}" style="${rectStyle(it)}" title="${esc(it.text || '')}"><span>${esc(it.label)}</span></div>`).join('');
  renderZoneLayer(new Set(hits.map((h) => h.zone.id)));
  msg.className = `occ-frame-msg${hits.length ? ' bad' : ''}`;
  if (hits.length) {
    msg.innerHTML = hits.map((h) => {
      const d = describeEvent({ ...h, kind: h.item.kind, label: h.item.label, start: f.t, end: f.t, crop: !!h.crop }, pname());
      return `<p><b>${esc(d.title)}</b>，建议${esc(d.suggestion)}</p>`;
    }).join('');
  } else {
    msg.innerHTML = `<p>第 ${fmtAt(f.t)}：${items.length ? `${items.length} 处字幕 / 文字（绿框），都没有被挡住。` : '这一帧没有识别到字幕或文字。'}</p>`;
  }
}

// ---------- 手动框选的文字 ----------
/** 视频画面上的手动框：框选模式下可编辑（所有框都显示），平时不显示（已经作为“标记文字”画在识别框里） */
function renderManual() {
  const layer = $('#occManual');
  if (!layer) return;
  layer.classList.toggle('on', S.marking);
  $('#occBoxes').hidden = S.marking;
  layer.innerHTML = S.marking ? S.manual.map((b, i) => boxHtml(b, i, { selected: i === S.selMan, label: `标记 ${i + 1}` })).join('') : '';
}

/** 右侧的手动框列表：时间段、删除 */
function renderManualList() {
  const box = $('#occManualList');
  if (!S.manual.length) { box.innerHTML = ''; return; }
  const dur = Math.round(duration() * 10) / 10;
  box.innerHTML = `<div class="man-head"><b>手动标记的文字（${S.manual.length}）</b><span class="hint">在这些时间段里，每个抽帧都按“有这段文字”检查</span></div>
    ${S.manual.map((m, i) => `<div class="man-row ${i === S.selMan && S.marking ? 'on' : ''}" data-i="${i}">
      <span class="man-name">标记 ${i + 1}</span>
      <label>第 <input type="number" step="0.1" min="0" max="${dur}" data-k="start" value="${m.start}"> 秒</label>
      <label>到 <input type="number" step="0.1" min="0" max="${dur}" data-k="end" value="${m.end}"> 秒</label>
      <button class="btn ghost sm" data-man="now">从当前时间开始</button>
      <button class="btn ghost sm" data-man="all">整段</button>
      <button class="btn ghost sm" data-man="del">删除</button>
    </div>`).join('')}`;
}

function removeManual(i) {
  S.manual.splice(i, 1);
  S.selMan = -1;
  renderManual();
  renderManualList();
  renderResults();
  S.lastFrameT = undefined;
  onTime();
  notify('update');
}

function setMarking(on) {
  S.marking = on;
  S.selMan = -1;
  if (on) video()?.pause();
  $('#occMark').textContent = on ? '完成框选' : '框选文字';
  $('#occMark').classList.toggle('primary', on);
  renderManual();
  renderManualList();
  S.lastFrameT = undefined;
  onTime();
}

function seekTo(t) {
  const v = video();
  if (!v) return;
  v.pause();
  S.lastFrameT = undefined;
  v.currentTime = Math.max(0, Number.isFinite(v.duration) ? Math.min(t, v.duration - 0.01) : t);
}
function togglePlay() {
  const v = video();
  if (v) (v.paused ? v.play() : v.pause());
}

// ============================================================
// 渲染
// ============================================================
function renderSettings() {
  const has = !!state.original?.info;
  $('#occEmpty').hidden = has;
  $('#occBody').hidden = !has;
  if (!has) return;
  $('#occPlatform').textContent = pname();
  $('#occPlatformCfg').textContent = pname();
  $('#occCalibrate').href = `calibrate.html?p=${encodeURIComponent(state.platform)}`;
  const hasFixed = !!state.fixed?.info;
  if (!hasFixed && S.src === 'fixed') S.src = 'original';
  $('#occSrcField').hidden = !hasFixed;
  document.querySelectorAll('#occSrcSeg button').forEach((b) => b.classList.toggle('on', b.dataset.src === S.src));
  $('#occThVal').textContent = `${Math.round(S.th * 100)}%`;
  $('.occ-settings').classList.toggle('off', S.running || S.previewOnly);
  const blocked = state.busy ? '技术体检正在处理视频，完成后再检查' : '';
  $('#occRun').disabled = S.running || !!blocked;
  $('#occRun').textContent = S.result ? '重新检查' : '开始检查';
  // 预计耗时（有的文件读不到时长，就不估算）
  const dur = slotOf(S.src)?.info?.durationSec;
  if (blocked) $('#occEstimate').textContent = blocked;
  else if (dur) {
    const n = sampleTimes(dur, S.interval).length;
    const sec = n * (EST_OCR_SEC / suggestedOcrWorkers() + 0.1) + 3;
    $('#occEstimate').textContent = `约 ${n} 帧，预计 ${sec < 60 ? Math.ceil(sec) + ' 秒' : Math.ceil(sec / 60) + ' 分钟'}`;
  } else $('#occEstimate').textContent = '';
}

function renderResults() {
  const a = S.previewOnly ? null : analysis();
  const r = S.result;
  const showRes = !!a && !S.running;
  $('#occTimeline').hidden = !showRes;
  // 结论
  if (S.previewOnly) {
    $('#occVerdict').innerHTML = '';
  } else if (!r && !a) {
    $('#occVerdict').innerHTML = S.running ? '' : `<p class="hint">点「开始检查」识别画面里的字幕和文字；识别不到的（花字、竖排字等）可以点左下「框选文字」手动框出来。左边是视频在${esc(pname())}上的样子，虚线框是界面会盖住的区域。</p>`;
  } else {
    const n = a.events.length;
    $('#occVerdict').innerHTML = `<div class="verdict-title"><span class="verdict-icon ${n ? 'warn' : 'pass'}">${n ? '!' : '✓'}</span>${n
      ? `发现 ${n} 处可能被挡住或裁掉的地方`
      : '字幕和文字都没有被挡住'}</div>
      <div class="hint">${r ? `检查了 ${r.frames.length} 帧${r.src === 'fixed' ? '（处理后的视频）' : ''}` : '只检查了手动标记的文字，点「开始检查」自动识别其余字幕'}${S.manual.length && r ? `，含 ${S.manual.length} 处手动标记` : ''} · 挡住 ≥ ${Math.round(S.th * 100)}% 算问题 · 点下面的条目或时间轴查看画面</div>`;
  }
  // 问题列表
  $('#occEvents').innerHTML = showRes ? a.events.map((ev) => {
    const d = describeEvent(ev, pname());
    return `<li data-key="${esc(ev.key + '@' + ev.start)}" data-t="${ev.worst.t}" class="${S.selKey === ev.key + '@' + ev.start ? 'on' : ''}">
      <span class="ev-title">${esc(d.title)}</span><span>${esc(d.reason)}</span><span class="ev-sug"><b>建议：</b>${esc(d.suggestion)}</span></li>`;
  }).join('') : '';
  // 时间轴标记：每个有问题的抽帧一个
  if (showRes) {
    const track = $('#occTrack'), dur = duration() || 1;
    track.querySelectorAll('.m').forEach((m) => m.remove());
    const byT = new Map();
    for (const h of a.hits) byT.set(h.t, (byT.get(h.t) === 'occ' || !h.crop) ? 'occ' : 'crop');
    for (const [t, kind] of byT) {
      const m = document.createElement('button');
      m.className = `m ${kind}`;
      m.style.left = `${(t / dur) * 100}%`;
      m.dataset.t = t;
      m.title = `第 ${fmtAt(t)}`;
      track.appendChild(m);
    }
  }
  // 统计
  $('#occStats').textContent = S.previewOnly ? '' : r?.stats || '';
  // 标签页上的问题数
  const n = a?.events.length || 0;
  $('#countOcc').textContent = a && n ? n : '';
  $('#countOcc').className = `count ${n ? 'warn' : ''}`;
}

/** 配置里的界面区域列表（折叠在最下面） */
function renderConfig() {
  const ov = currentPlatform()?.overlay;
  if (!ov?.zones?.length) { $('#occZones').innerHTML = '<p class="hint">当前平台还没有配置界面区域。</p>'; return; }
  const fit = ov.videoFit === 'cover'
    ? `比例接近屏幕的视频铺满屏幕、裁掉多出来的边缘；比例差别大的（例如横屏）完整显示、留黑边`
    : '完整显示，不够的地方留黑边';
  $('#occZones').innerHTML = `<ul class="zone-list">${ov.zones.map((z) =>
    `<li><b>${esc(z.name)}</b><span class="hint">${esc(z.desc || '')}</span><span class="num hint">x ${z.x}% · y ${z.y}% · 宽 ${z.w}% · 高 ${z.h}%</span></li>`).join('')}</ul>
    <p class="hint">视频摆放：${fit}。来源：${esc(ov.source || '未注明')}（${esc(ov.date || '')}）</p>`;
}

function renderAll() {
  renderSettings();
  if (!state.original?.info) return;
  buildPhone();
  renderManual();
  renderManualList();
  renderResults();
  renderConfig();
  S.lastFrameT = undefined;
  onTime();
}

// ============================================================
// 检查
// ============================================================
function progress(label, pct) {
  $('#occProgress').hidden = false;
  $('#occProgLabel').textContent = label;
  $('#occProgPct').textContent = pct == null ? '' : `${Math.round(pct * 100)}%`;
  $('#occProgBar').style.width = `${Math.round((pct || 0) * 100)}%`;
}

/** 文字行的叫法：画面下半部分的当作字幕，其他叫文字 */
const textLabel = (b) => (b.y + b.h / 2 >= 55 ? '字幕' : '文字');

async function run() {
  if (S.running || state.busy) return;
  const slot = slotOf(S.src);
  if (!slot?.url) return;
  const interval = S.interval;
  S.running = true;
  S.cancel = false;
  // 取消信号：终止识别线程后，排队中的识别任务不会再返回，所有等待都要和它“赛跑”
  const canceled = new Promise((_, reject) => { S.abort = () => reject(new Error('已取消')); });
  canceled.catch(() => {});
  S.result = null;
  S.selKey = null;
  video()?.pause();
  renderAll();
  const name = slot.file?.name || '视频';
  const T0 = performance.now();
  let src = null;
  try {
    progress('加载识别模型（首次约几秒）…', 0);
    const nWorkers = suggestedOcrWorkers();
    const tl = performance.now();
    await Promise.race([ensureOCR(nWorkers), canceled]);
    const loadMs = performance.now() - tl;
    src = await openVideo(slot.url);
    const times = sampleTimes(src.duration, interval);
    const frames = new Array(times.length);
    const pending = new Set();
    let done = 0, sampleMs = 0, lastT = performance.now();
    const tOcr0 = performance.now();
    const tick = () => progress(`识别中：${done} / ${times.length} 帧`, done / times.length);
    tick();
    await sampleFrames(src, times, MAX_SIDE, async (c, t, i) => {
      sampleMs += performance.now() - lastT;
      const W = c.width, H = c.height;
      const pct = (b) => ({ x: (b.x / W) * 100, y: (b.y / H) * 100, w: (b.w / W) * 100, h: (b.h / H) * 100 });
      const fr = { t, items: [] };
      frames[i] = fr;
      const p = recognizeText(c)
        .then((lines) => { fr.items.push(...lines.map((l) => { const b = pct(l); return { kind: 'text', label: textLabel(b), text: l.text, ...b }; })); })
        .finally(() => { pending.delete(p); done++; if (!S.cancel) tick(); });
      pending.add(p);
      if (pending.size >= nWorkers * 2) await Promise.race([Promise.race(pending).catch(() => {}), canceled]); // 排队太多就等一等
      lastT = performance.now();
    }, () => S.cancel);
    await Promise.race([Promise.all(pending), canceled]);
    if (S.cancel) throw new Error('已取消');
    const totalMs = performance.now() - T0, ocrWall = performance.now() - tOcr0;
    const n = frames.length;
    const w = Math.round(src.width * Math.min(1, MAX_SIDE / Math.max(src.width, src.height)));
    const h = Math.round(src.height * Math.min(1, MAX_SIDE / Math.max(src.width, src.height)));
    const parts = [`共抽取 ${n} 帧（每 ${interval} 秒一帧，缩小到 ${w}×${h}）`];
    parts.push(`文字识别 ${nWorkers} 个线程，平均每帧 ${(ocrWall / n / 1000).toFixed(2)} 秒`);
    parts.push(`抽帧共 ${(sampleMs / 1000).toFixed(1)} 秒`, `加载模型 ${(loadMs / 1000).toFixed(1)} 秒`, `总耗时 ${(totalMs / 1000).toFixed(1)} 秒`);
    S.result = {
      id: Date.now(), src: S.src, url: slot.url, aspect: src.width / src.height, duration: src.duration, interval, frames,
      stats: parts.join(' · '),
    };
    const mediaSec = src.duration;
    addTiming({ step: '画面遮挡：加载模型', fileName: '—', mediaSec: null, ms: loadMs, note: `Tesseract ×${nWorkers}` });
    addTiming({ step: '画面遮挡：抽帧 + 识别', fileName: name, mediaSec, ms: totalMs - loadMs, note: `${n} 帧 · 每 ${interval} 秒 · ${w}×${h}` });
  } catch (e) {
    if (!S.cancel) {
      console.error(e);
      $('#occVerdict').innerHTML = `<p class="occ-frame-msg bad">检查失败：${esc(e.message || e)}</p>`;
    }
  } finally {
    if (src) src.video.removeAttribute('src');
    S.running = false;
    S.abort = null;
    $('#occProgress').hidden = true;
    if (S.result) {
      renderAll();
      // 自动跳到第一个问题
      const first = analysis()?.events[0];
      if (first) selectEvent(first.key + '@' + first.start, first.worst.t);
    } else { renderSettings(); if (S.cancel) renderResults(); }
    notify('update'); // 让总报告刷新
  }
}

function selectEvent(key, t) {
  S.selKey = key;
  document.querySelectorAll('#occEvents li').forEach((li) => li.classList.toggle('on', li.dataset.key === key));
  document.querySelectorAll('#occTrack .m').forEach((m) => m.classList.toggle('on', +m.dataset.t === t));
  seekTo(t);
}

function cancelRun() {
  if (!S.running) return;
  S.cancel = true;
  progress('正在取消…', null);
  S.abort?.();
  disposeOCR();
}

function reset() {
  cancelRun();
  S.result = null;
  S.selKey = null;
  S.phoneKey = '';
  S.src = 'original';
  S.manual = [];
  S.marking = false;
  S.selMan = -1;
  $('#occMark').textContent = '框选文字';
  $('#occMark').classList.remove('primary');
  $('#occManualList').innerHTML = '';
  $('#occPhoneWrap').innerHTML = '';
  $('#countOcc').textContent = '';
}

// ============================================================
// 挂载
// ============================================================
export function mount() {
  $('#occRun').addEventListener('click', run);
  $('#occCancel').addEventListener('click', cancelRun);
  $('#occInterval').addEventListener('change', (e) => { S.interval = +e.target.value; renderSettings(); });
  $('#occTh').addEventListener('input', (e) => { S.th = +e.target.value / 100; renderSettings(); renderResults(); S.lastFrameT = undefined; onTime(); notify('update'); });
  $('#occSrcSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b || S.running || b.dataset.src === S.src) return;
    S.src = b.dataset.src;
    S.result = null; // 换了视频版本，旧结果和手动框作废
    S.manual = [];
    setMarking(false);
    renderAll();
    notify('update');
  });
  $('#occPreviewOnly').addEventListener('change', (e) => { S.previewOnly = e.target.checked; renderAll(); if (S.previewOnly) video()?.play(); });
  $('#occShowZones').addEventListener('change', (e) => { S.showZones = e.target.checked; S.lastFrameT = undefined; onTime(); });
  $('#occPlay').addEventListener('click', togglePlay);
  $('#occMark').addEventListener('click', () => setMarking(!S.marking));
  $('#occManualList').addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]'), k = e.target.dataset.k;
    if (!row || !k) return;
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    const m = S.manual[+row.dataset.i];
    m[k] = Math.max(0, Math.min(v, duration()));
    if (m.start > m.end) [m.start, m.end] = [m.end, m.start];
    renderResults();
    S.lastFrameT = undefined;
    onTime();
    notify('update');
  });
  $('#occManualList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-man]'), row = e.target.closest('[data-i]');
    if (!b || !row) return;
    const i = +row.dataset.i, m = S.manual[i];
    if (b.dataset.man === 'del') return removeManual(i);
    if (b.dataset.man === 'all') { m.start = 0; m.end = Math.round(duration() * 10) / 10; }
    if (b.dataset.man === 'now') m.start = Math.round((video()?.currentTime || 0) * 10) / 10;
    if (m.start > m.end) m.end = Math.round(duration() * 10) / 10;
    renderManualList();
    renderResults();
    S.lastFrameT = undefined;
    onTime();
    notify('update');
  });
  $('#occEvents').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-key]');
    if (li) selectEvent(li.dataset.key, +li.dataset.t);
  });
  $('#occTrack').addEventListener('click', (e) => {
    const m = e.target.closest('.m');
    if (m) { selectEvent(null, +m.dataset.t); return; }
    const b = e.currentTarget.getBoundingClientRect();
    if (S.result?.duration) seekTo(((e.clientX - b.left) / b.width) * S.result.duration);
  });

  subscribe((reason) => {
    if (reason === 'before-new-file') { reset(); S.autoPending = false; return; }
    if (reason === 'analyzed' && autoChecksEnabled() && (state.original?.info?.durationSec || 0) <= AUTO_MAX_SEC) S.autoPending = true;
    // 导入后自动检查：等分析结束（不忙）再开始，在后台跑，不切换页面
    if (S.autoPending && !state.busy && !S.running && state.original?.info) {
      S.autoPending = false;
      if (!S.result) setTimeout(run, 0);
    }
    if (reason === 'fixed' && S.result?.src === 'fixed') { S.result = null; S.phoneKey = ''; }
    if (reason === 'nav' && state.tab === 'occlusion' && state.navArg != null) {
      const t = +state.navArg;
      state.navArg = null;
      renderAll();
      const ev = analysis()?.events.find((x) => x.times.includes(t));
      if (ev) selectEvent(ev.key + '@' + ev.start, t); else seekTo(t);
      return;
    }
    if (reason === 'nav' && state.tab !== 'occlusion') video()?.pause();
    if (['config', 'platform', 'analyzed', 'fixed', 'busy', 'nav'].includes(reason)) renderAll();
  });
  renderAll();
}
