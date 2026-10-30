// ============================================================
// media.js —— 拖入视频、读取参数、分析响度（全站只做一次，所有模块共用结果）
// ============================================================
import { state, notify } from './store.js';
import { showTask, hideTask, showError, clearError, setBusy, timed, addTiming, currentMode, beginStages, stage } from './ui.js';
import { probeFile } from '../lib/probe.js';
import { loadFFmpeg, ffmpegLoaded, analyzeLoudness, probeFpsFallback, terminateFFmpeg, makeTestVideo } from '../lib/ffmpeg-tools.js';
import { rememberVideo } from '../lib/recent-videos.js';

/** 确保 ffmpeg 已加载；首次加载会记录耗时 */
export async function ensureFFmpeg() {
  const mode = currentMode();
  if (!ffmpegLoaded(mode)) stage('加载 ffmpeg 核心');
  showTask(`加载 ffmpeg 核心（${mode === 'mt' ? '多线程' : '单线程'}，约 32MB，首次较慢）…`);
  const t0 = performance.now();
  const loaded = await loadFFmpeg(mode);
  if (loaded) {
    addTiming({ step: '加载 ffmpeg 核心', fileName: '—', ms: performance.now() - t0, mediaSec: null, note: mode === 'mt' ? '多线程' : '单线程' });
  }
}

/**
 * 对一个视频 slot 做完整分析：读参数 + 响度。
 * 原视频由 loadVideo 调用；技术体检处理完的视频也用它复检。
 */
export async function analyzeSlot(slot, label) {
  // 阶段清单只给原视频显示（处理后的复检由一键修复自己的阶段清单负责）
  const st = (name) => { if (label === '原视频') stage(name); };
  // 1) 读取参数（mediainfo.js）
  st('读取参数');
  showTask(`${label}：读取视频参数…`);
  const { info } = await timed('读取参数', slot.file.name, null, () => probeFile(slot.file), 'mediainfo.js');
  slot.info = info;
  slot.loudPending = info.hasAudio;
  notify('update');

  // 1.5) mediainfo 读不到帧率时（常见于可变帧率 MKV），用 ffmpeg 读文件头补充
  if (info.hasVideo && info.frameRate == null) {
    try {
      await ensureFFmpeg();
      st('补充探测帧率');
      showTask(`${label}：补充探测帧率…`);
      info.frameRate = await timed('补充探测帧率', slot.file.name, null, () => probeFpsFallback(slot.file), 'ffmpeg -i 文件头');
      info.frameRateEstimated = true;
    } catch (e) {
      console.warn('补充探测帧率失败', e);
    }
  }

  // 2) 响度分析（ffmpeg loudnorm）
  if (info.hasAudio) {
    try {
      await ensureFFmpeg();
      st('分析声音');
      showTask(`${label}：分析声音…`, 0);
      slot.loud = await timed('响度分析', slot.file.name, info.durationSec,
        () => analyzeLoudness(slot.file, info.durationSec, (p) => showTask(`${label}：分析声音…`, p)),
        `loudnorm · ${currentMode() === 'mt' ? '多线程' : '单线程'}`);
    } catch (e) {
      slot.loudError = e.message || String(e);
      terminateFFmpeg();
      showError('声音分析失败：' + slot.loudError);
    } finally {
      slot.loudPending = false;
    }
  }
  notify('update');
}

/** 释放某个 slot 占用的 blob URL（视频、截帧），避免内存泄漏 */
export function revokeSlot(slot) {
  if (!slot) return;
  if (slot.url) URL.revokeObjectURL(slot.url);
  (slot.frames || []).forEach((u) => u && URL.revokeObjectURL(u));
}

/**
 * 载入一个新视频：通知各模块清理旧结果 → 读参数 → 分析响度 → 通知“分析完成”。
 * 各模块在 'analyzed' 时根据新视频重新生成自己的内容。
 * 同时把视频记进“最近导入的视频”（复制到本机浏览器存储，下次打开页面自动载入），和分析同时进行。
 * @param {File} file
 * @param {{remember?: boolean, ref?: {dir,name}, restored?: boolean}} opts
 *   remember 是否记住（从“最近导入”里打开的不用再存）；ref 文件已在本机存储里的位置（处理历史的结果）；restored 是否为打开页面时自动载入
 */
export async function loadVideo(file, { remember = true, ref = null, restored = false } = {}) {
  if (state.busy) return;
  clearError();
  notify('before-new-file');          // 各模块清掉和旧视频有关的结果（例如技术体检的处理结果）
  revokeSlot(state.original);
  state.original = { file, restored, ref }; // ref：载入的是处理结果时它在本机存储里的位置（删除处理结果时别删掉正在用的文件）
  if (remember) {
    rememberVideo(file, ref)
      .then((r) => { if (!r) console.warn('浏览器存储空间不足或不支持，这个视频不会被记住'); notify('recent'); })
      .catch((e) => console.warn('记住视频失败：', e));
  }
  state.previewSrc = 'original';
  state.tab = 'tech';
  state.techTab = 'report';
  setBusy(true);
  beginStages();
  try {
    await analyzeSlot(state.original, '原视频');
    notify('analyzed');
  } catch (e) {
    console.error(e);
    showError('分析失败：' + (e.message || e));
  } finally {
    setBusy(false);
    hideTask();
    notify('update');
  }
}

/** 生成一段“有问题”的测试视频并载入（没有素材时体验用） */
export async function loadTestVideo() {
  if (state.busy) return;
  clearError();
  setBusy(true);
  let file = null;
  try {
    await ensureFFmpeg();
    showTask('生成测试视频…');
    file = await timed('生成测试视频', '—', 8, () => makeTestVideo(8), 'lavfi + libx264 ultrafast');
  } catch (err) {
    showError('生成测试视频失败：' + (err.message || err));
  } finally {
    setBusy(false);
    hideTask();
  }
  if (file) await loadVideo(file);
}
