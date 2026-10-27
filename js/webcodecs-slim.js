// ============================================================
// webcodecs-slim.js —— 用 WebCodecs（浏览器硬件编解码）做“上传前瘦身”的速度测试
// 只做一件事：短边缩到 1080（不放大）+ 固定原帧率 + H.264 目标码率，输出 MP4。
// 实际转码逻辑在 webcodecs.js（主页面的“上传前瘦身”也用它）。
// 视频同样不离开本机。
// ============================================================
import { hasWebCodecs, readVideoMeta, transcodeWithWebCodecs } from './lib/webcodecs.js';
import { resolveCheck } from './lib/rules-engine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;

const state = { file: null, meta: null, slim: null, runs: [], conversion: null, outUrl: null };

// ---------- 环境检测：浏览器支不支持、有没有硬件编解码 ----------
async function checkEnv() {
  const rows = [];
  const has = hasWebCodecs();
  rows.push(['WebCodecs', has ? '✅ 支持' : '❌ 不支持（请用新版 Chrome / Edge）']);
  if (has) {
    // isConfigSupported 只能说明“这个配置能用”，prefer-hardware 能通过基本说明有硬件编码器
    const enc = async (hw) => (await VideoEncoder.isConfigSupported({
      codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30, hardwareAcceleration: hw,
    }).catch(() => ({ supported: false }))).supported;
    const dec = async (codec, hw) => (await VideoDecoder.isConfigSupported({
      codec, codedWidth: 3840, codedHeight: 2160, hardwareAcceleration: hw,
    }).catch(() => ({ supported: false }))).supported;
    rows.push(['H.264 1080P 硬件编码', (await enc('prefer-hardware')) ? '✅ 可用' : '⚠️ 不可用（会用软件编码，较慢）']);
    rows.push(['H.264 1080P 软件编码', (await enc('prefer-software')) ? '✅ 可用' : '❌ 不可用']);
    rows.push(['HEVC 4K 硬件解码（手机原片常用）', (await dec('hvc1.1.6.L153.B0', 'prefer-hardware')) ? '✅ 可用' : '⚠️ 不可用（HEVC 原片可能无法处理）']);
    rows.push(['H.264 4K 硬件解码', (await dec('avc1.640033', 'prefer-hardware')) ? '✅ 可用' : '⚠️ 不可用']);
  }
  rows.push(['CPU 逻辑核心', navigator.hardwareConcurrency || '?']);
  $('#envTable').innerHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
}

// ---------- 读瘦身参数（和主页面共用 config/platforms.json 里的 spec.slim） ----------
async function loadSlim() {
  try {
    const res = await fetch('config/platforms.json?t=' + Date.now());
    const j = await res.json();
    state.slimAll = j.platforms;
  } catch (e) {
    state.slimAll = null;
  }
}
function currentSlim() {
  const p = state.slimAll?.[$('#platformSel').value];
  const minRule = p?.spec?.rules?.find((r) => r.check.metric === 'videoBitrateKbps' && r.check.op === 'gte');
  return {
    maxShort: p?.spec?.slim?.maxShortSide || 1080,
    kbps: p?.spec?.slim?.targetKbps || { fps30: 10000, fps60: 16000 },
    minRule: minRule?.check,
  };
}

const snapFps = (fps) => [24, 25, 30, 48, 50, 60, 120].reduce((b, s) => (Math.abs(s - fps) < Math.abs(b - fps) ? s : b), 30);

// ---------- 读取文件基本信息 ----------
async function loadFile(file) {
  state.file = file;
  $('#runBtn').disabled = true;
  $('#fileInfo').textContent = '读取中…';
  try {
    state.meta = await readVideoMeta(file);
    const m = state.meta;
    $('#fileInfo').innerHTML = `<b>${esc(file.name)}</b> · ${fmtMB(file.size)} · ${m.w}×${m.h} · ${m.codec} · ` +
      `${m.fps.toFixed(2)} fps · 约 ${m.kbps} kbps · ${m.duration.toFixed(2)} 秒 · 音频 ${esc(m.audio)}` +
      (m.canDecode ? '' : '<br><span class="bad">⚠️ 这个浏览器无法解码该视频编码，无法用 WebCodecs 处理</span>');
    $('#runBtn').disabled = !m.canDecode;
    renderPlan();
  } catch (e) {
    $('#fileInfo').innerHTML = `<span class="bad">读取失败：${esc(e.message || e)}</span>`;
  }
}

/** 根据原片和瘦身参数算出输出尺寸、帧率、码率 */
function computePlan() {
  const m = state.meta, s = currentSlim();
  const short = Math.min(m.w, m.h);
  const scale = short > s.maxShort ? s.maxShort / short : 1; // 只缩小不放大
  const even = (x) => Math.round(x / 2) * 2;                 // H.264 要求宽高为偶数
  const fps = snapFps(m.fps);
  const want = fps >= 48 ? s.kbps.fps60 : s.kbps.fps30;
  // 码率下限按输出清晰度取档（规则里可能按短边分档）
  const minKbps = resolveCheck(s.minRule, { shortSide: Math.round(short * scale) }).value || 0;
  const kbps = Math.round(Math.max(minKbps, Math.min(want, m.kbps || want)));
  return { w: even(m.w * scale), h: even(m.h * scale), fps, kbps };
}
function renderPlan() {
  if (!state.meta) return;
  const p = computePlan();
  $('#plan').textContent = `计划输出：${p.w}×${p.h} · 固定 ${p.fps} fps · H.264 约 ${p.kbps} kbps · 音频能直接复制就复制（AAC），否则转 AAC`;
}

// ---------- 执行瘦身 ----------
async function run() {
  if (!state.file || !state.meta) return;
  const p = computePlan();
  const hw = $('#hwSel').value;
  $('#runBtn').disabled = true;
  $('#cancelBtn').hidden = false;
  $('#result').innerHTML = '';
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  await state.lastOut?.remove(); // 上一次的结果在本地磁盘（OPFS）的临时目录里，删掉
  const setProg = (x, label) => {
    $('#bar').style.width = `${x * 100}%`;
    $('#progLabel').textContent = label;
  };
  setProg(0, '准备中…');
  const t0 = performance.now();
  try {
    const res = await transcodeWithWebCodecs(state.file, { width: p.w, height: p.h, fps: p.fps, kbps: p.kbps, hw },
      (x) => setProg(x, `${Math.round(x * 100)}% · 已用 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`),
      { onConversion: (c) => { state.conversion = c; } });
    const dropped = res.dropped;
    state.lastOut = res.out;
    const sec = (performance.now() - t0) / 1000;
    const outFile = new File([res.file], state.file.name.replace(/\.[^.]+$/, '') + '_1080p_webcodecs.mp4', { type: 'video/mp4' });
    state.outUrl = URL.createObjectURL(outFile);
    setProg(1, `完成 · ${sec.toFixed(1)} 秒`);

    const run = {
      name: state.file.name, src: `${state.meta.w}×${state.meta.h} ${state.meta.codec} ${state.meta.fps.toFixed(0)}fps`,
      out: `${p.w}×${p.h} ${p.fps}fps ${p.kbps}kbps`, hw, sec, dur: state.meta.duration,
      before: state.file.size, after: outFile.size,
    };
    state.runs.push(run);
    renderRuns();
    const mbps = parseFloat($('#bwInput').value) || 30;
    const up = (b) => (b * 8) / (mbps * 1e6);
    const viaSlim = sec + up(outFile.size), direct = up(state.file.size);
    $('#result').innerHTML = `
      <p>✅ ${fmtMB(state.file.size)} → <b>${fmtMB(outFile.size)}</b>（缩小 ${Math.round((1 - outFile.size / state.file.size) * 100)}%），
        耗时 <b>${sec.toFixed(1)} 秒</b>，速度 <b>${(state.meta.duration / sec).toFixed(2)}x 实时</b>
        · <a href="${state.outUrl}" download="${esc(outFile.name)}">下载</a></p>
      <p>按上行 ${mbps} Mbps 算总账：转码 ${sec.toFixed(1)} 秒 + 上传 ${up(outFile.size).toFixed(1)} 秒 = <b>${viaSlim.toFixed(1)} 秒</b>，
        直接上传原片 <b>${direct.toFixed(1)} 秒</b> →
        ${viaSlim < direct ? '<span class="good">先瘦身再上传更快</span>' : '<span class="bad">直接上传原片更快</span>'}</p>
      ${dropped.length ? `<p class="bad">${esc(dropped.join('；'))}</p>` : ''}
      <video src="${state.outUrl}" controls playsinline></video>`;
  } catch (e) {
    console.error(e);
    setProg(0, '失败');
    $('#result').innerHTML = `<p class="bad">失败：${esc(e.message || e)}</p>`;
  } finally {
    state.conversion = null;
    $('#runBtn').disabled = false;
    $('#cancelBtn').hidden = true;
  }
}

function renderRuns() {
  $('#runsTable').innerHTML = `<tr><th>文件</th><th>原片</th><th>输出</th><th>编码偏好</th><th>耗时</th><th>速度</th><th>大小</th></tr>` +
    state.runs.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.src)}</td><td>${esc(r.out)}</td><td>${r.hw}</td>
      <td>${r.sec.toFixed(1)} 秒</td><td>${(r.dur / r.sec).toFixed(2)}x 实时</td>
      <td>${fmtMB(r.before)} → ${fmtMB(r.after)}</td></tr>`).join('');
}

// ---------- 事件 ----------
$('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });
$('#runBtn').addEventListener('click', run);
$('#cancelBtn').addEventListener('click', () => state.conversion?.cancel());
$('#platformSel').addEventListener('change', renderPlan);

await Promise.all([checkEnv(), loadSlim()]);
window.__wc = { state, loadFile, run }; // 调试用
