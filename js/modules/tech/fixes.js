// ============================================================
// fixes.js —— 技术体检 › 一键修复（弹窗见 fix-dialog.js）：修复项定义、建议勾选、处理流程（快速通道 / 退回 ffmpeg）、处理结果
// ============================================================
import { state, notify, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, showTask, hideTask, showError, clearError, setBusy, timed, currentMode } from '../../core/ui.js';
import { ensureFFmpeg, analyzeSlot, revokeSlot } from '../../core/media.js';
import { probeFile } from '../../lib/probe.js';
import { runFix, terminateFFmpeg, extractFrames, outputFps, LOUD_TARGET, LOUD_TP, MAX_GAIN_DB } from '../../lib/ffmpeg-tools.js';
import { hasWebCodecs, checkWebCodecs, transcodeWithWebCodecs, captureFramesWebCodecs, muxTracks, canCopyToMp4,
  removeOPFSFile, VERTICAL_W, VERTICAL_H } from '../../lib/webcodecs.js';
import { evaluate, suggestFixes, resolveCheck } from '../../lib/rules-engine.js';
import { saveHistory } from './history-view.js';
import { checkBrowser } from '../../core/compat.js';

/** 清掉上一次的处理结果 */
export function resetOutputs() {
  // 先清掉播放器再释放 blob URL，否则播放器会报“文件不存在”
  $('#videoCompare').innerHTML = '';
  delete $('#videoCompare').dataset.key;
  revokeSlot(state.fixed);
  // 上一次的结果如果没存进处理历史（保存失败或已从历史删除），把它在本地磁盘上的文件也删掉
  const prev = state.fixed?.out;
  if (prev?.onDisk && !state.fixed.historyId) removeOPFSFile(prev.dir, prev.name);
  state.fixed = null;
  if (state.original) {
    (state.original.frames || []).forEach((u) => u && URL.revokeObjectURL(u));
    state.original.frames = null;
  }
  $('#fixDone').innerHTML = '';
}


// ============================================================
// 一键修复：修复项定义
// ============================================================
/**
 * 从当前平台规则中读出修复目标值（改 JSON 里的数值，修复目标会跟着变）
 * 规则按 check.metric 查找，找不到就是 undefined，对应修复项会被禁用
 * @param {{spec: {rules: Array, slim?: object}}} platform 平台配置（config/platforms.json 里 platforms 下的一项）
 */
export function fixTargets(platform, info) {
  const rules = platform?.spec?.rules || [];
  const by = (metric) => rules.find((r) => r.check.metric === metric)?.check;
  const t = {};
  const fr = by('frameRate'); if (fr?.op === 'between') t.fpsRange = [Math.ceil(fr.value[0]), Math.floor(fr.value[1])];
  const ss = by('shortSide'); if (ss?.op === 'gte') t.minShort = ss.value;
  // 码率下限可能按清晰度分档：minKbpsFor(短边) 给出某个清晰度的下限；minKbps 先按原片清晰度取，处理时再按输出清晰度改（见 resolveOutputFloor）
  const br = by('videoBitrateKbps');
  if (br?.op === 'gte') {
    t.minKbpsFor = (shortSide) => resolveCheck(br, { shortSide }).value;
    t.minKbps = t.minKbpsFor(info?.shortSide);
  }
  const du = by('durationSec'); if (du?.op === 'lte') t.maxSec = du.value;
  const fs = by('fileSizeMB'); if (fs?.op === 'lte') t.maxMB = fs.value;
  const sr = by('sampleRate'); if (sr?.op === 'in') t.sampleRate = sr.value.includes(48000) ? 48000 : sr.value[0];
  const ch = by('channels'); if (ch?.op === 'lte') t.maxChannels = ch.value;
  // 上传前瘦身参数（平台级配置，不是检查规则）
  const slim = platform?.spec?.slim;
  if (slim?.targetKbps) {
    t.slimShort = slim.maxShortSide || 1080;
    t.slimKbps = slim.targetKbps; // { fps30, fps60 }
  }
  return t;
}

/**
 * 码率下限按“处理后”的清晰度取档：瘦身缩到 1080、放大到 720、横屏转竖屏输出 1080×1920 时，下限跟着输出走
 * （例如 4K 原片瘦身到 1080P，用 1080P 的下限，而不是 4K 的）
 */
export function resolveOutputFloor(t, info, fixes) {
  if (!t.minKbpsFor || !info?.shortSide) return t;
  let short = info.shortSide;
  if (fixes.vertical) short = Math.min(VERTICAL_W, VERTICAL_H);
  else if (fixes.slim && t.slimShort && short > t.slimShort) short = t.slimShort;
  else if (fixes.upscale && t.minShort && short < t.minShort) short = t.minShort;
  return { ...t, minKbps: t.minKbpsFor(short), outShort: short };
}

/**
 * 所有修复项。title 为名称；desc 为一句话说明（可以是函数，用到目标值）；
 * enabled(t, slot) 返回 true，或一段文字（不可用的原因）
 */
export const FIX_DEFS = [
  { id: 'slim', group: '上传前瘦身', title: '上传前瘦身',
    desc: (t) => `短边缩到 ${t.slimShort}px、固定原帧率、码率约 ${t.slimKbps.fps30 / 1000}～${t.slimKbps.fps60 / 1000} Mbps；文件小很多，上传更快`,
    enabled: (t, s) => (!t.slimKbps ? '规则里没有瘦身配置' : s.info.hasVideo || '没有视频轨') },
  { id: 'to_mp4', group: '格式', title: '转成 MP4（H.264 + AAC）', desc: '兼容性最好的格式' },
  { id: 'trim', group: '格式', title: '截断时长', desc: (t) => `只保留前 ${t.maxSec} 秒`, enabled: (t) => !!t.maxSec || '规则里没有时长上限' },
  { id: 'compress', group: '格式', title: '压缩体积', desc: (t) => `压到 ${t.maxMB} MB 以内`, enabled: (t) => !!t.maxMB || '规则里没有大小上限' },
  { id: 'to_cfr', group: '视频', title: '固定帧率', desc: '可变帧率改为固定，避免上传后卡顿、音画不同步' },
  { id: 'fps_range', group: '视频', title: '调整帧率', desc: (t) => `调到 ${t.fpsRange[0]}～${t.fpsRange[1]} fps 之间`, enabled: (t) => !!t.fpsRange || '规则里没有帧率范围' },
  { id: 'hdr_to_sdr', group: '视频', title: 'HDR 转 SDR', desc: '由浏览器做色彩转换，避免上传后发灰', enabled: (t, s) => s.info.isHDR || '不是 HDR 视频' },
  { id: 'upscale', group: '视频', title: '放大分辨率', desc: (t) => `短边放大到 ${t.minShort}px，争取平台的高清档位；画面不会变清晰（效果未验证）`, enabled: (t) => !!t.minShort || '规则里没有分辨率要求' },
  { id: 'bitrate_floor', group: '视频', title: '码率下限', desc: (t) => `处理后画质余量（码率）不低于 ${t.minKbps} kbps，避免被平台再压坏`, enabled: (t) => !!t.minKbps || '规则里没有码率下限' },
  { id: 'loudnorm', group: '音频', title: '统一音量', desc: `把音量调到和大多数视频差不多（${LOUD_TARGET} LUFS），并压住峰值避免破音（≤ ${LOUD_TP} dBTP）；原片太安静时最多提升 ${MAX_GAIN_DB} dB，避免把噪音一起放大`,
    enabled: (t, s) => (!s.info.hasAudio ? '没有音轨' : s.loud?.audioSilent ? '音轨全程静音' : (!!s.loud || '声音分析未完成')) },
  { id: 'resample', group: '音频', title: '统一采样率', desc: (t) => `改为 ${t.sampleRate} Hz`, enabled: (t, s) => (s.info.hasAudio ? (!!t.sampleRate || '规则里没有采样率要求') : '没有音轨') },
  { id: 'downmix', group: '音频', title: '下混为立体声', desc: '多声道改为双声道，手机外放人声更清楚', enabled: (t, s) => s.info.hasAudio || '没有音轨' },
  { id: 'add_audio', group: '音频', title: '添加静音音轨', desc: '视频没有音轨时补一条，避免部分平台报错', enabled: (t, s) => !s.info.hasAudio || '已有音轨' },
];
const REENCODE_FIXES = ['to_cfr', 'fps_range', 'hdr_to_sdr', 'upscale', 'compress'];

/** 某个修复项对当前视频是否可用：true 或不可用原因 */
export function fixAvailability(id) {
  const d = FIX_DEFS.find((x) => x.id === id);
  const o = state.original;
  if (!d || !o?.info) return '—';
  return d.enabled ? d.enabled(fixTargets(currentPlatform(), o.info), o) : true;
}

/** 根据当前平台和原视频，重建修复项列表：建议项放在最上面并勾选，其余收进“更多选项” */
export function applySuggestedFixes() {
  const o = state.original;
  if (!o?.info) return;
  const rules = currentRules();
  const t = fixTargets(currentPlatform(), o.info);
  const results = evaluate(rules, metricsOf(o), { loudnessPending: o.loudPending });
  const s = suggestFixes(results);
  // 瘦身建议：原片短边超过上限，或码率明显高于目标（1.5 倍以上）时，先缩小再上传能快很多
  if (t.slimKbps && o.info.hasVideo) {
    const want = (o.info.frameRate || 30) >= 48 ? t.slimKbps.fps60 : t.slimKbps.fps30;
    if (o.info.shortSide > t.slimShort || (o.info.videoBitrateKbps || 0) > want * 1.5) s.add('slim');
  }
  // 只要会重新编码视频，就顺带勾上“码率下限”，避免修复后码率反而不达标（瘦身自带码率控制，不需要）
  if (!s.has('slim') && t.minKbps && (REENCODE_FIXES.some((id) => s.has(id)) || (s.has('to_mp4') && o.info.videoCodec !== 'AVC'))) s.add('bitrate_floor');

  const items = FIX_DEFS.map((d) => ({ d, ok: d.enabled ? d.enabled(t, o) : true, suggested: s.has(d.id) }));
  const row = ({ d, ok, suggested }) => {
    const on = ok === true;
    const desc = on ? (typeof d.desc === 'function' ? d.desc(t) : d.desc) : ok;
    return `<label class="fix-item ${on ? '' : 'disabled'}">
      <input type="checkbox" data-fix="${d.id}" ${on && suggested ? 'checked' : ''} ${on ? '' : 'disabled'}>
      <div><div class="f-title">${esc(d.title)}</div><div class="f-desc">${esc(desc)}</div></div>
    </label>`;
  };
  const rec = items.filter((x) => x.ok === true && x.suggested);
  const rest = items.filter((x) => !(x.ok === true && x.suggested));
  // 更多选项：按分组列出，可用的在前、不可用的在后
  const groups = {};
  [...rest.filter((x) => x.ok === true), ...rest.filter((x) => x.ok !== true)].forEach((x) => (groups[x.d.group] ||= []).push(x));
  const restOn = rest.filter((x) => x.ok === true).length;
  $('#fixList').innerHTML =
    (rec.length
      ? `<div class="fix-sec-title">建议修复 <span class="badge warn">${rec.length}</span></div><div class="fix-items">${rec.map(row).join('')}</div>`
      : '<p class="hint" style="margin:0 0 12px">体检没有发现需要修复的问题，下面的选项可以按需使用。</p>') +
    `<details class="more" ${rec.length ? '' : 'open'}><summary>更多选项（${restOn} 项可用）</summary><div class="fix-items">` +
    Object.entries(groups).map(([g, xs]) => `<div class="f-group">${g}</div>${xs.map(row).join('')}`).join('') +
    `</div></details>`;
  updateFixButton();
}

/** 勾选了几项修复 */
export const selectedCount = () => Object.values(selectedFixes()).filter(Boolean).length;

/** 按勾选数量更新弹窗里的“开始处理”和体检结论旁的“一键修复”按钮 */
export function updateFixButton() {
  const n = selectedCount();
  $('#fixBtn').textContent = n ? `开始处理（${n} 项）` : '开始处理';
  const open = $('#openFix');
  // 有问题但修复项还没算出来（例如声音还在分析）时仍叫“一键修复”；确实没问题才叫“更多处理选项”
  if (open) open.textContent = n ? `一键修复（${n} 项）` : open.classList.contains('primary') ? '一键修复' : '更多处理选项';
}

export function selectedFixes() {
  const f = {};
  document.querySelectorAll('#fixList input[data-fix]').forEach((el) => { f[el.dataset.fix] = el.checked && !el.disabled; });
  return f;
}

/**
 * 执行处理（一键修复 或 横屏转竖屏），之后自动复检、截帧对比
 * @param {'fix'|'vertical'} kind
 * @returns {Promise<boolean>} 是否处理成功（结果在 state.fixed）
 */
export async function doProcess(kind) {
  const o = state.original;
  if (!o?.info || state.busy) return false;
  let fixes = selectedFixes();
  if (kind === 'vertical') {
    if (!$('#verticalWithFixes').checked) fixes = {};
    fixes.vertical = true;
    fixes.upscale = false; // 竖屏输出固定 1080×1920，放大项没有意义
  } else if (!Object.values(fixes).some(Boolean)) {
    alert('请至少勾选一项修复');
    return false;
  }
  clearError();
  setBusy(true);
  resetOutputs();
  notify('update');
  const preset = $('#presetSel').value;
  const crf = +$('#crfSel').value;
  const targets = resolveOutputFloor(fixTargets(currentPlatform(), o.info), o.info, fixes);
  const label = kind === 'vertical' ? '横屏转竖屏' : '一键修复';
  const t0 = performance.now();
  state.canceled = false;
  try {
    let res = null;
    let note = '';
    // 优先走“快速通道”（WebCodecs 转码 + 直接复制合并，结果边做边写盘）；不行再退回 ffmpeg.wasm
    const route = await chooseRoute(o, fixes);
    if (route.fast) {
      try {
        res = await fastPipeline(o, fixes, targets, label, { preset, crf }, route);
      } catch (e) {
        // 取消、或音频步骤出错（换 ffmpeg 整体处理也会一样失败）时不退回
        if (state.canceled || e.stage === 'audio') throw e;
        console.warn('快速处理失败，退回 ffmpeg.wasm：', e);
        note = `快速处理失败（${e.message || e}）`;
      }
    } else if (route.reason) {
      note = route.reason;
    }
    if (!res) {
      await ensureFFmpeg();
      showTask(`${label}：处理中（ffmpeg.wasm）…`, 0);
      res = await timed(`转码（${label}）`, o.file.name, o.info.durationSec,
        () => runFix(o.file, o.info, o.loud, fixes, { preset, crf, targets }, (p) => showTask(`${label}：处理中（ffmpeg.wasm）…`, p)),
        `ffmpeg.wasm ${currentMode() === 'mt' ? '多线程' : '单线程'} · ${Object.keys(fixes).filter((k) => fixes[k]).join('+')} · preset=${preset}`);
      if (note) res.plan.push(`注意：${note}，改用 ffmpeg.wasm 处理${route.encode ? '，视频转码会很慢' : ''}`);
    }

    // processMs：转码总耗时（不含复检），用于“算总账”；out：结果在本地磁盘（OPFS）上的位置
    state.fixed = { file: res.file, plan: res.plan, args: res.args, kind, fixes, processMs: performance.now() - t0, out: res.out || null,
      url: URL.createObjectURL(res.file), createdAt: Date.now() };
    // 处理后自动复检
    await analyzeSlot(state.fixed, '处理后');
    // 截取同一时间点的画面，用于直观对比
    await captureFrames();
    // 存进处理历史，之后重新处理或刷新页面都不会丢
    await saveHistory();
    notify('fixed');
    return true;
  } catch (e) {
    console.error(e);
    terminateFFmpeg(); // 出错后 worker 状态可能不干净，下次重新加载
    showError(state.canceled ? `${label}已取消。` : `${label}失败：` + (e.message || e));
    return false;
  } finally {
    state.conversion = null;
    setBusy(false);
    hideTask();
    notify('update');
  }
}

/** 是否需要重新编码视频 */
function needsVideoEncode(info, fixes) {
  return !!(fixes.slim || fixes.to_cfr || fixes.fps_range || fixes.upscale || fixes.bitrate_floor || fixes.compress ||
    fixes.vertical || (fixes.hdr_to_sdr && info.isHDR) || (fixes.to_mp4 && info.videoCodec !== 'AVC'));
}

/** 是否需要 ffmpeg 处理音频（浏览器的 AAC 编码器不一定可用，所以音频不是 AAC 时也交给 ffmpeg） */
const needsAudioWork = (info, fixes) => !!(fixes.loudnorm || fixes.resample || fixes.downmix ||
  (fixes.add_audio && !info.hasAudio) || (info.hasAudio && info.audioCodec !== 'AAC'));

/**
 * 决定走哪条路：
 *   快速通道（fast）：
 *     - 要重新编码视频（含 HDR → SDR、横屏转竖屏）：WebCodecs，需要浏览器能解码该视频
 *     - 只改音频 / 封装：视频直接复制进 MP4，需要视频编码能装进 MP4（H.264 / HEVC / VP9 / AV1）
 *     两种情况下原片视频都不会进入 ffmpeg.wasm 的内存，结果直接写盘，长视频也不怕
 *   否则退回 ffmpeg.wasm 整体处理（慢，且受约 2GB 内存上限限制）
 *   HDR → SDR 走 WebCodecs：浏览器解码后会做色彩转换，实测（HLG 手机原片）与浏览器显示原片一致
 */
async function chooseRoute(o, fixes) {
  if (!o.info.hasVideo) return { fast: false, encode: false };
  const encode = needsVideoEncode(o.info, fixes);
  showTask('检查处理方式…');
  if (encode) {
    const wc = await checkWebCodecs(o.file);
    return wc.ok ? { fast: true, encode } : { fast: false, encode, reason: `无法使用 WebCodecs：${wc.reason}` };
  }
  const c = await canCopyToMp4(o.file);
  const ok = c.video && (c.audio || needsAudioWork(o.info, fixes));
  return ok ? { fast: true, encode } : { fast: false, encode, reason: '这个视频的编码不能直接复制进 MP4' };
}

/**
 * 快速通道，最多三步，中间文件都在本地磁盘（OPFS）上，结束后删除：
 *   ① （按需）ffmpeg.wasm 只处理音频，输出 m4a
 *   ② （按需）WebCodecs 直接读原片：缩放 / 横屏转竖屏 / 固定帧率 / HDR → SDR / 转 H.264 / 码率控制 / 截断
 *   ③ （按需）把视频轨和音频轨直接复制合并成 MP4（不重新编码）
 */
async function fastPipeline(o, fixes, t, label, enc, route) {
  const plan = ['容器：输出 MP4'];
  let args = [];
  let dur = o.info.durationSec;
  const trimEnd = fixes.trim && t.maxSec && dur > t.maxSec ? t.maxSec : undefined;
  if (trimEnd) {
    dur = trimEnd;
    plan.push(`时长：截断为前 ${trimEnd} 秒（原 ${o.info.durationSec} 秒）`);
  }
  const audioWork = needsAudioWork(o.info, fixes);
  const mux = audioWork || !route.encode; // 只有“WebCodecs 一步出结果”时不需要合并
  const total = (audioWork ? 1 : 0) + (route.encode ? 1 : 0) + (mux ? 1 : 0);
  let n = 0;
  const stepLabel = (txt) => `${label}：${total > 1 ? `第 ${++n}/${total} 步 ` : ''}${txt}…`;

  const stamp = Date.now();
  const base = o.file.name.replace(/\.[^.]+$/, '');
  const displayName = `${base}_${fixes.vertical ? 'vertical' : 'fixed'}.mp4`;
  const finalOut = { dir: 'outputs', name: `${stamp}_${displayName}`, displayName };
  const tmp = []; // 中间文件，结束后删除

  try {
    // ① 音频
    let audioFile = null;
    if (audioWork) {
      await ensureFFmpeg();
      const l1 = stepLabel('音频处理（ffmpeg）');
      showTask(l1, 0);
      const r1 = await timed('音频处理（ffmpeg）', o.file.name, dur,
        () => runFix(o.file, o.info, o.loud, fixes, { ...enc, targets: t, audioOnly: true }, (p) => showTask(l1, p)),
        '只处理音频，输出 m4a').catch((e) => { e.stage = 'audio'; throw e; });
      audioFile = r1.file;
      args = r1.args;
      plan.push(...r1.plan.filter((x) => !x.startsWith('时长：')));
    }

    // ② 视频
    let videoFile = o.file;
    if (route.encode) {
      const p = { ...videoParams(o.info, fixes, t, dur), trimEnd, noAudio: !!audioFile };
      const l2 = stepLabel(fixes.vertical ? '横屏转竖屏（WebCodecs）' : '视频转码（WebCodecs）');
      showTask(l2, 0);
      let i = 0;
      const encode = (pp, step) => timed(step, o.file.name, dur,
        () => transcodeWithWebCodecs(o.file, { ...pp, out: mux ? { dir: 'tmp', name: `${stamp}_v${i++}.mp4`, displayName: 'video.mp4' } : finalOut },
          (x) => showTask(l2, x), { onConversion: (c) => { state.conversion = c; } }),
        `${pp.width}×${pp.height} · ${pp.fps ? pp.fps + ' fps' : '原帧率'} · 目标 ${pp.kbps} kbps${pp.noAudio ? ' · 只出视频' : ''}`);
      let r2 = await encode(p, fixes.vertical ? '横屏转竖屏（WebCodecs）' : '视频转码（WebCodecs）');
      let used = p, retryNote = '';
      // 浏览器编码器在简单画面上常常达不到目标码率（实测低 10%~40%，且不支持恒定码率模式）。
      // 若结果低于平台码率下限，按比例提高目标再编一次（只重试一次）
      if (t.minKbps && p.how !== '接近原片画质' && !p.how.startsWith('压缩')) {
        const actual = (await probeFile(r2.file)).info.videoBitrateKbps;
        if (actual && actual < t.minKbps) {
          const p2 = { ...p, kbps: Math.round(Math.min(p.kbps * 3, p.kbps * (t.minKbps * 1.1) / actual)) };
          showTask(`${label}：实际码率 ${actual} kbps 低于下限，提高目标重新编码…`, 0);
          await r2.out.remove();
          r2 = await encode(p2, '视频转码重试（码率不足）');
          used = p2;
          retryNote = `视频：首次编码实际码率 ${actual} kbps 低于下限 ${t.minKbps}，已把目标提高到 ${p2.kbps} kbps 重新编码`;
        }
      }
      state.conversion = null;
      const size = p.width === o.info.width && p.height === o.info.height ? `${p.width}×${p.height}` : `${o.info.width}×${o.info.height} → ${p.width}×${p.height}`;
      plan.push(`视频（WebCodecs）：${fixes.vertical ? `横屏 ${o.info.width}×${o.info.height} → 竖屏 ${p.width}×${p.height}（上下模糊背景填充）` : size}，` +
        `${p.fps ? `固定 ${p.fps} fps${p.fpsNote}` : '保持原帧率'}，H.264 目标码率 ${used.kbps} kbps（${p.how}）`);
      if (retryNote) plan.push(retryNote);
      // 安卓手机浏览器实测：转码后画面颜色明显改变（发灰、偏黄绿），在处理记录里也提醒一次
      if (checkBrowser().mobile) plan.push('注意：在手机浏览器里转码，实测画面颜色可能明显改变，请对比处理前后的画面；建议用电脑上的 Chrome / Edge 重新处理');
      if (o.info.isHDR) {
        // 浏览器转码一定输出 SDR（BT.709），没勾 HDR → SDR 也一样
        plan.push(`视频：HDR（${o.info.hdrFormat}）→ SDR BT.709，由浏览器完成色彩转换（实测与浏览器显示原片一致）` +
          (fixes.hdr_to_sdr ? '' : '；注意：浏览器转码总会输出 SDR，即使没勾“HDR → SDR”'));
      }
      plan.push(...r2.dropped.map((d) => '注意：' + d));
      if (!mux) return { file: r2.file, plan, args, out: r2.out };
      videoFile = r2.file;
      tmp.push(r2.out);
    } else {
      plan.push(`视频：直接复制 ${o.info.videoCodec} 流（不重新编码）`);
    }

    // ③ 合并（视频、音频都直接复制）
    const l3 = stepLabel('合并音视频（不重新编码）');
    showTask(l3, 0);
    const audioSrc = audioFile || (o.info.hasAudio ? o.file : null);
    const r3 = await timed('合并音视频', o.file.name, dur,
      () => muxTracks(videoFile, audioSrc, { trimEnd: route.encode ? undefined : trimEnd, duration: dur, out: finalOut }, (x) => showTask(l3, x)),
      '直接复制，不重新编码');
    plan.push(`合并：${audioFile ? '处理后的音频' : '原音频'}和视频直接复制进 MP4，不重新编码`);
    return { file: r3.file, plan, args, out: r3.out };
  } finally {
    for (const f of tmp) await f.remove();
  }
}

/** 算出 WebCodecs 的输出尺寸 / 帧率 / 码率（目标值都来自平台规则） */
function videoParams(info, fixes, t, outDuration) {
  const short = info.shortSide;
  let targetShort = short;
  if (fixes.slim && t.slimShort && short > t.slimShort) targetShort = t.slimShort;        // 瘦身：只缩小
  else if (fixes.upscale && t.minShort && short < t.minShort) targetShort = t.minShort;   // 勾了“放大”才放大
  const scale = targetShort / short;
  const even = (x) => Math.round(x / 2) * 2;                                              // H.264 要求偶数
  // 输出尺寸：横屏转竖屏固定 1080×1920，否则按比例缩放
  const outW = fixes.vertical ? VERTICAL_W : even(info.width * scale);
  const outH = fixes.vertical ? VERTICAL_H : even(info.height * scale);
  const pixelScale = Math.sqrt((outW * outH) / (info.width * info.height)); // 用于按像素数换算码率

  // 帧率：重新编码一律输出固定帧率（见 outputFps）
  const { fps, note: fpsNote } = outputFps(info, fixes, t.fpsRange);

  // 码率。硬件编码器在简单画面上常常达不到目标（实测可低 15%），对平台码率下限留 10% 余量
  const src = info.videoBitrateKbps;
  const floor = (t.minKbps || 0) * 1.1;
  let kbps, how;
  if (fixes.slim && t.slimKbps) {
    const want = (fps || 30) >= 48 ? t.slimKbps.fps60 : t.slimKbps.fps30;
    kbps = Math.max(floor, Math.min(want, src || want));
    how = '瘦身目标';
  } else if (fixes.bitrate_floor && t.minKbps) {
    kbps = Math.max(floor, Math.min(src || 0, t.minKbps * 2));
    how = '保证码率下限';
  } else {
    // 尽量保持原片画质：按像素数比例换算；H.264 压缩效率比 HEVC 低，HEVC 源多给 30%
    kbps = src ? src * pixelScale * pixelScale * (/HEVC|AV1/.test(info.videoCodec) ? 1.3 : 1) : 8000;
    kbps = Math.min(kbps, 100000);
    how = '接近原片画质';
  }
  if (fixes.compress && t.maxMB && outDuration) {
    const cap = Math.max(300, Math.floor((t.maxMB * 8 * 1024 * 0.95) / outDuration - 192));
    if (cap < kbps) { kbps = cap; how = `压缩到 ≤ ${t.maxMB} MB`; }
  }
  return { width: outW, height: outH, vertical: !!fixes.vertical, fps, fpsNote, kbps: Math.round(kbps), how };
}

/** 在原视频和处理后视频的同一时间点（20% / 50% / 80%）各截一帧；优先 WebCodecs，失败再用 ffmpeg */
async function captureFrames() {
  const o = state.original, f = state.fixed;
  const dur = Math.min(o.info.durationSec || 0, f.info.durationSec || 0);
  if (!dur || !o.info.hasVideo) return;
  const times = [0.2, 0.5, 0.8].map((r) => +(dur * r).toFixed(2));
  const used = [];
  const grab = async (file) => {
    if (hasWebCodecs()) {
      try {
        const urls = await captureFramesWebCodecs(file, times);
        used.push('WebCodecs');
        return urls;
      } catch (e) {
        console.warn('WebCodecs 截帧失败，改用 ffmpeg：', e);
      }
    }
    await ensureFFmpeg();
    used.push('ffmpeg');
    return extractFrames(file, times);
  };
  showTask('截取对比画面…');
  await timed('截取对比画面', `${o.file.name} / ${f.file.name}`, null, async () => {
    o.frames = await grab(o.file);
    f.frames = await grab(f.file);
  }, () => `${times.length} 个时间点 × 2 · ${[...new Set(used)].join(' / ')}`);
  state.frameTimes = times;
}

// ---------- 修复弹窗（列表由 applySuggestedFixes 生成，这里只管按钮状态和竖屏选项） ----------
export function renderFixTab() {
  const o = state.original;
  if (!o?.info) return;
  $('#fixBtn').disabled = state.busy;
  const landscape = o.info.orientation === '横屏';
  $('#verticalSec').hidden = !o.info.hasVideo || !landscape; // 只有横屏视频才需要“横屏转竖屏”
  $('#verticalBtn').disabled = state.busy || !landscape;
  $('#verticalHint').textContent = landscape ? '' : `当前视频是${o.info.orientation}，不需要转换。`;
}

