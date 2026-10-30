// ============================================================
// ffmpeg-tools.js —— 封装 ffmpeg.wasm：加载、响度分析、一键修复转码
// 所有处理都在浏览器的 Web Worker 里完成，文件不离开本机。
// ============================================================
import { FFmpeg } from '../../vendor/ffmpeg/index.js';

const abs = (p) => new URL(p, import.meta.url).href;

// 两种核心：单线程（兼容性最好）/ 多线程（更快，但需要 COOP/COEP 响应头）
const CORES = {
  st: { coreURL: abs('../../vendor/ffmpeg-core/ffmpeg-core.js'), wasmURL: abs('../../vendor/ffmpeg-core/ffmpeg-core.wasm') },
  mt: {
    coreURL: abs('../../vendor/ffmpeg-core-mt/ffmpeg-core.js'),
    wasmURL: abs('../../vendor/ffmpeg-core-mt/ffmpeg-core.wasm'),
    workerURL: abs('../../vendor/ffmpeg-core-mt/ffmpeg-core.worker.js'),
  },
};

let ffmpeg = null;      // 当前 FFmpeg 实例
let loadedMode = null;  // 'st' | 'mt'
let logListener = null; // 当前任务的日志回调

/** 是否支持多线程（页面需处于 crossOriginIsolated 状态才能用 SharedArrayBuffer） */
export const canUseMT = () => self.crossOriginIsolated === true;

/**
 * 加载 ffmpeg 核心。返回 true 表示本次真正执行了加载（用于统计耗时）
 * @param {'st'|'mt'} mode
 */
export async function loadFFmpeg(mode = 'st') {
  if (mode === 'mt' && !canUseMT()) mode = 'st';
  if (ffmpeg && loadedMode === mode) return false;
  if (ffmpeg) ffmpeg.terminate(); // 切换模式时销毁旧实例
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => logListener && logListener(message));
  await ffmpeg.load(CORES[mode]);
  loadedMode = mode;
  return true;
}

/** 某个核心是否已经加载好（加载好了就不用在进度里显示“加载 ffmpeg 核心”） */
export const ffmpegLoaded = (mode = 'st') => !!ffmpeg && loadedMode === (mode === 'mt' && !canUseMT() ? 'st' : mode);

/** 强制终止当前任务（取消按钮用），下次调用会重新加载 */
export function terminateFFmpeg() {
  if (ffmpeg) ffmpeg.terminate();
  ffmpeg = null;
  loadedMode = null;
}

/**
 * 把 File 挂载进 ffmpeg 的虚拟文件系统。
 * 优先用 WORKERFS（按需读取，不复制整个文件，适合大文件）；失败则退回 writeFile（整体复制进内存）。
 * 返回 { path, cleanup }
 */
async function mountInput(file) {
  const dir = '/in_' + Date.now();
  await ffmpeg.createDir(dir);
  try {
    const ok = await ffmpeg.mount('WORKERFS', { files: [file] }, dir);
    if (ok === false) throw new Error('WORKERFS 不可用');
    return {
      path: `${dir}/${file.name}`,
      cleanup: async () => { if (!ffmpeg) return; await ffmpeg.unmount(dir); await ffmpeg.deleteDir(dir); }, // 取消后 ffmpeg 已销毁
    };
  } catch (e) {
    console.warn('WORKERFS 挂载失败，改用 writeFile：', e);
    const path = `${dir}/input${extOf(file.name)}`;
    await ffmpeg.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return {
      path,
      cleanup: async () => { if (!ffmpeg) return; await ffmpeg.deleteFile(path); await ffmpeg.deleteDir(dir); },
    };
  }
}

const extOf = (name) => (name.match(/\.[^.]+$/) || [''])[0];

/**
 * 执行一条 ffmpeg 命令，收集日志并回调进度（0~1）
 * @param {string[]} args
 * @param {number|null} durationSec 用于计算进度
 * @param {(p:number)=>void} onProgress
 */
async function run(args, durationSec, onProgress, allowFail = false) {
  const logs = [];
  logListener = (msg) => {
    logs.push(msg);
    // 从 "time=00:01:23.45" 解析当前处理到的时间点
    const m = msg.match(/time=\s*(\d+):(\d+):([\d.]+)/);
    if (m && durationSec && onProgress) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      onProgress(Math.min(1, t / durationSec));
    }
  };
  try {
    let code;
    try {
      code = await ffmpeg.exec(args);
    } catch (e) {
      // ffmpeg.wasm 内部线程崩溃时会抛出这个不太直观的错误
      if (/startsWith/.test(String(e))) throw new Error(`ffmpeg 核心崩溃（多线程模式下较常见），请切换为单线程后重试。\n${logs.slice(-5).join('\n')}`);
      throw e;
    }
    if (code !== 0 && !allowFail) {
      const tail = logs.slice(-15).join('\n');
      throw new Error(`ffmpeg 退出码 ${code}\n${tail}`);
    }
    onProgress && onProgress(1);
    return logs;
  } finally {
    logListener = null;
  }
}

/** 从 loudnorm 打印的日志中解析出 JSON 结果 */
function parseLoudnormJSON(logs) {
  const text = logs.join('\n');
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('未能解析 loudnorm 输出');
  return JSON.parse(text.slice(start, end + 1));
}

// 响度统一的目标。真峰值留到 -2 dBTP：大幅提升音量后再编码成 AAC，峰值会冒出来一点（实测 -1.5 → -0.7）
export const LOUD_TARGET = -14, LOUD_TP = -2;
// 最多提升多少 dB：原片太安静时硬拉到 -14 LUFS 会把背景噪音一起放大
export const MAX_GAIN_DB = 15;

/**
 * 响度分析：使用 loudnorm 滤镜的测量模式（单遍），得到整体响度 / 真峰值 / 响度范围。
 * 同时把原始测量值返回，供“响度统一”第二遍使用（双遍 loudnorm 更准确）。
 */
export async function analyzeLoudness(file, durationSec, onProgress) {
  const input = await mountInput(file);
  try {
    const logs = await run([
      '-hide_banner', '-i', input.path,
      '-vn', '-sn', '-dn',                                   // 只处理音频，跳过视频解码，速度快很多
      '-af', `loudnorm=I=${LOUD_TARGET}:TP=${LOUD_TP}:LRA=11:print_format=json`,
      '-f', 'null', '-',
    ], durationSec, onProgress);
    const j = parseLoudnormJSON(logs);
    // 全程静音（录屏没录到声音时常见）：loudnorm 会给出 -inf，无法测量也无法统一响度
    if (!Number.isFinite(parseFloat(j.input_i))) {
      return { audioSilent: true, loudnessLUFS: null, truePeakDBTP: null, loudnessRangeLU: null, measured: j };
    }
    return {
      audioSilent: false,
      loudnessLUFS: +parseFloat(j.input_i).toFixed(1),
      truePeakDBTP: +parseFloat(j.input_tp).toFixed(1),
      loudnessRangeLU: +parseFloat(j.input_lra).toFixed(1),
      measured: j, // 原始测量值
    };
  } finally {
    await input.cleanup();
  }
}

/**
 * 补充探测帧率：mediainfo 对部分可变帧率文件（如 MKV）读不到帧率时使用。
 * 只运行 `ffmpeg -i 文件`（不指定输出，只读文件头），从日志 "Stream ... Video: ..., 29.97 fps" 中解析。
 */
export async function probeFpsFallback(file) {
  const input = await mountInput(file);
  try {
    const logs = await run(['-hide_banner', '-i', input.path], null, null, true);
    const line = logs.find((l) => /Stream #.*Video:/.test(l)) || '';
    const m = line.match(/([\d.]+)\s*fps/) || line.match(/([\d.]+)\s*tbr/);
    return m ? +parseFloat(m[1]).toFixed(3) : null;
  } finally {
    await input.cleanup();
  }
}

// 横屏转竖屏的输出尺寸（9:16）
const VERTICAL_W = 1080, VERTICAL_H = 1920;

/**
 * 横屏转竖屏滤镜：画面复制两份
 *   背景：缩到 1/4 尺寸后铺满裁切 → 模糊 → 再放大回目标尺寸（在小图上模糊，速度快很多，效果几乎一样）
 *   前景：按宽度缩放到 W，保持原比例
 *   最后把前景叠在背景正中间
 */
function verticalBlurFilter(W, H) {
  const bw = W / 4, bh = H / 4;
  return `split=2[fg][bg];` +
    `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:2,scale=${W}:${H}[bgb];` +
    `[fg]scale=${W}:-2[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

/**
 * 固定帧率的目标值。
 * 普通可变帧率（手机拍摄）：按平均帧率吸附到标准帧率；
 * 变化很大的可变帧率（录屏：画面不动时 1fps，滑动时 60~90fps）：平均值会远低于实际流畅度，改按最高帧率取，
 * 再限制在平台帧率范围内（没有范围时最高 60），避免滑动时掉帧卡顿。
 * @returns {{fps:number, note:string}}
 */
export function targetFps(info, fpsRange) {
  const avg = info.frameRate || 30;
  const bursty = info.isVFR && info.frameRateMax && avg < info.frameRateMax * 0.8;
  let fps = bursty ? Math.min(info.frameRateMax, 60) : avg;
  if (fpsRange) fps = Math.min(Math.max(fps, fpsRange[0]), fpsRange[1]);
  fps = snapFps(fps);
  return {
    fps,
    note: bursty ? `（帧率变化很大，平均 ${avg} / 最高 ${info.frameRateMax} fps，常见于录屏；按最高帧率取，避免滑动时卡顿）` : '',
  };
}

/**
 * 重新编码时的输出帧率：一律输出固定的【标准】帧率（24 / 25 / 30 / 50 / 60…）。
 * 不吸附的话，编码后的时间戳会带着原片的微小抖动；非标准帧率（例如 25.986）的每帧时长也无法用 MP4 的时间单位整除，
 * 帧时长会交替变化——两种情况都会被判成“可变帧率”（实测 25.986 fps 的固定帧率原片，保持原帧率重编后被判可变）。
 * 25.986 → 25 大约每 26 帧丢 1 帧，看不出来。
 */
export function outputFps(info, fixes, fpsRange) {
  const r = targetFps(info, fixes.fps_range ? fpsRange : null);
  if (!r.note && info.frameRate && Math.abs(info.frameRate - r.fps) > 0.01) r.note = '（吸附到标准帧率，每帧时长一致）';
  return r;
}

/** 把平均帧率吸附到最近的标准帧率 */
export function snapFps(fps) {
  const std = [24, 25, 30, 48, 50, 60, 120];
  if (!fps) return 30;
  return std.reduce((best, s) => (Math.abs(s - fps) < Math.abs(best - fps) ? s : best), 30);
}

/**
 * 一键修复：根据勾选的修复项，用【一次】ffmpeg 转码完成全部修复（比分多次跑快）。
 * @param {File} file
 * @param {object} info      probe 得到的参数
 * @param {object|null} loud 响度分析结果（含 measured）
 * @param {object} fixes     勾选的修复项，键名见下方说明；vertical 为额外功能“横屏转竖屏”
 *   to_mp4 转 MP4(H.264+AAC) | trim 截断时长 | compress 压缩体积 | to_cfr 固定帧率 | fps_range 帧率范围
 *   hdr_to_sdr HDR→SDR | upscale 放大分辨率 | bitrate_floor 码率下限 | loudnorm 响度统一
 *   resample 统一采样率 | downmix 下混立体声 | add_audio 添加静音音轨 | vertical 横屏转竖屏
 *   slim 上传前瘦身（短边缩到上限、固定原帧率、按帧率的目标码率）
 * @param {object} opts { preset, crf, targets, audioOnly }  targets 为从平台规则里读出的目标值（见 app.js fixTargets）
 *        audioOnly=true：只输出处理后的音频（.m4a），不碰视频——视频由 WebCodecs 直接读原片处理，最后再合并。
 *        这样原片视频不会被复制进 ffmpeg.wasm 的内存（上限约 2GB，长的 4K 原片会撑爆）
 * @returns {{file: File, args: string[], plan: string[]}}
 */
export async function runFix(file, info, loud, fixes, opts, onProgress) {
  const t = opts.targets || {};
  const plan = [];   // 给人看的处理说明
  const args = ['-hide_banner'];
  const input = await mountInput(file);
  args.push('-i', input.path);

  // 没有音轨时可以补一条静音音轨（lavfi 虚拟输入）
  const addAudio = fixes.add_audio && !info.hasAudio;
  if (addAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  if (opts.audioOnly) {
    args.push('-map', addAudio ? '1:a:0' : '0:a:0', '-vn', '-sn', '-dn');
    if (addAudio) args.push('-t', String(info.durationSec)); // 静音源是无限长的，按视频时长截
  } else {
    args.push('-map', '0:v:0?', '-map', addAudio ? '1:a:0' : '0:a:0?', '-sn', '-dn');
    if (addAudio) args.push('-shortest');
  }

  // ---------- 时长 ----------
  let outDuration = info.durationSec;
  if (fixes.trim && t.maxSec && info.durationSec > t.maxSec) {
    args.push('-t', String(t.maxSec));
    outDuration = t.maxSec;
    plan.push(`时长：截断为前 ${t.maxSec} 秒（原 ${info.durationSec} 秒）`);
  }

  // ---------- 视频 ----------
  const codec = info.videoCodec;
  // 这些修复项必须重新编码视频
  const needReencode = fixes.to_cfr || fixes.fps_range || fixes.hdr_to_sdr || fixes.upscale ||
    fixes.bitrate_floor || fixes.compress || fixes.vertical || fixes.slim;
  // 只有“已是 H.264”或者“HEVC 且没要求转 H.264”时才能直接复制视频流（最快，无画质损失）
  const canCopyVideo = !needReencode && (codec === 'AVC' || (codec === 'HEVC' && !fixes.to_mp4));
  if (info.hasVideo && !opts.audioOnly) {
    if (canCopyVideo) {
      args.push('-c:v', 'copy');
      if (codec === 'HEVC') args.push('-tag:v', 'hvc1'); // 苹果设备兼容
      plan.push(`视频：直接复制 ${codec} 流（不重新编码）`);
    } else {
      const vf = [];
      // 1) 帧率：可变 → 固定，或者调整到平台允许的范围（瘦身也会固定帧率，但保持原帧率档位 30 / 60）
      const { fps: outFps, note } = outputFps(info, fixes, t.fpsRange);
      vf.push(`fps=${outFps}`);
      args.push('-fps_mode', 'cfr', '-r', String(outFps));
      plan.push(`视频：帧率 ${info.frameRate ?? '?'}${info.isVFR ? '（可变）' : ''} → 固定 ${outFps} fps${note}`);
      // 2) 尺寸：横屏转竖屏 / 瘦身缩小到短边上限 / 放大到平台建议的短边
      //    放在 HDR 色调映射之前：先缩小，浮点色调映射的计算量能少好几倍（4K → 1080P 少 3/4）
      if (fixes.vertical) {
        vf.push(verticalBlurFilter(VERTICAL_W, VERTICAL_H));
        plan.push(`视频：横屏 ${info.width}×${info.height} → 竖屏 ${VERTICAL_W}×${VERTICAL_H}（上下模糊背景填充）`);
      } else if (fixes.slim && t.slimShort && info.shortSide > t.slimShort) {
        // 只缩小不放大；短边是高还是宽取决于横竖屏
        vf.push(info.height <= info.width ? `scale=-2:${t.slimShort}:flags=lanczos` : `scale=${t.slimShort}:-2:flags=lanczos`);
        plan.push(`瘦身：短边 ${info.shortSide}px → ${t.slimShort}px`);
      } else if (fixes.upscale && t.minShort && info.shortSide < t.minShort) {
        // 短边是高还是宽取决于横竖屏；-2 表示按比例算并保证是偶数
        vf.push(info.height <= info.width ? `scale=-2:${t.minShort}:flags=lanczos` : `scale=${t.minShort}:-2:flags=lanczos`);
        plan.push(`视频：短边 ${info.shortSide}px → ${t.minShort}px（lanczos 放大，不会增加细节）`);
      }
      // 3) HDR → SDR：转线性光 → 浮点 → BT.709 色域 → hable 色调映射 → BT.709 传输特性
      if (fixes.hdr_to_sdr && info.isHDR) {
        const tin = /HLG/.test(info.hdrFormat) ? 'arib-std-b67' : 'smpte2084';
        vf.push(`zscale=tin=${tin}:pin=bt2020:min=bt2020nc:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,` +
          `tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`);
        args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
        plan.push(`视频：HDR（${info.hdrFormat}）→ SDR BT.709（hable 色调映射）`);
      }
      vf.push('format=yuv420p');
      args.push('-vf', vf.join(','));
      args.push('-c:v', 'libx264', '-preset', opts.preset);

      // 4) 码率控制：压缩（硬性大小上限）> 上传前瘦身 > 码率下限 > CRF
      const audioKbps = info.hasAudio || addAudio ? 192 : 0;
      if (fixes.compress && t.maxMB && outDuration) {
        // 目标体积留 5% 余量给封装开销
        const totalKbps = (t.maxMB * 8 * 1024 * 0.95) / outDuration;
        const vk = Math.max(300, Math.floor(totalKbps - audioKbps));
        args.push('-b:v', `${vk}k`, '-maxrate', `${Math.round(vk * 1.5)}k`, '-bufsize', `${vk * 2}k`);
        plan.push(`视频：压缩到 ≤ ${t.maxMB} MB，平均码率 ${vk} kbps`);
        if (t.minKbps && vk < t.minKbps) plan.push(`注意：为满足大小上限，码率低于平台建议的 ${t.minKbps} kbps`);
      } else if (fixes.slim && t.slimKbps) {
        // 按输出帧率选目标码率；不低于平台码率下限，也不高于原片码率（原片本来就小时不做无用的放大）
        const want = outFps >= 48 ? t.slimKbps.fps60 : t.slimKbps.fps30;
        const vk = Math.round(Math.max(t.minKbps || 0, Math.min(want, info.videoBitrateKbps || want)));
        args.push('-b:v', `${vk}k`, '-maxrate', `${Math.round(vk * 1.5)}k`, '-bufsize', `${vk * 2}k`);
        plan.push(`瘦身：H.264 平均码率 ${vk} kbps（原片 ${info.videoBitrateKbps ?? '?'} kbps，${outFps} fps）`);
      } else if (fixes.bitrate_floor && t.minKbps) {
        // 平均码率取：不低于下限的 1.1 倍；源码率更高时最多跟到下限的 2 倍，避免文件无谓变大
        const vk = Math.round(Math.max(t.minKbps * 1.1, Math.min(info.videoBitrateKbps || 0, t.minKbps * 2)));
        args.push('-b:v', `${vk}k`, '-maxrate', `${Math.round(vk * 1.5)}k`, '-bufsize', `${vk * 2}k`);
        plan.push(`视频：重新编码为 H.264，平均码率 ${vk} kbps（保证 ≥ ${t.minKbps}；源画质低时提高码率不会变清晰）`);
      } else {
        args.push('-crf', String(opts.crf));
        plan.push(`视频：重新编码为 H.264（preset=${opts.preset}, crf=${opts.crf}）`);
      }
      // 多线程核心：必须显式指定线程数。默认的“自动”会开太多线程，超出 wasm 线程池导致崩溃（实测 >4 就会出错）
      if (loadedMode === 'mt') args.push('-threads', String(Math.min(4, navigator.hardwareConcurrency || 4)));
      if (info.isHDR && !fixes.hdr_to_sdr) plan.push('注意：HDR 源未做色调映射，输出画面可能发灰（可勾选“HDR → SDR”）');
    }
  }

  // ---------- 音频 ----------
  if (addAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
    plan.push('音频：添加一条静音立体声音轨（AAC）');
  } else if (info.hasAudio) {
    const af = [];
    if (fixes.loudnorm && loud?.audioSilent) {
      plan.push('音频：音轨全程静音，跳过响度统一');
    } else if (fixes.loudnorm && loud?.measured) {
      const m = loud.measured;
      // 源响度范围很大时，把目标 LRA 放宽，避免 loudnorm 退回动态压缩模式
      const lra = Math.max(11, Math.ceil(parseFloat(m.input_lra) || 0));
      // 提升上限：太安静的原片最多提升 MAX_GAIN_DB，不硬拉到目标
      const inI = parseFloat(m.input_i);
      const capped = inI + MAX_GAIN_DB < LOUD_TARGET;
      const target = capped ? +(inI + MAX_GAIN_DB).toFixed(1) : LOUD_TARGET;
      // 线性模式只能整体加减音量：如果加减后峰值会超过上限，ffmpeg 会自动把目标降低（实测原片 -15.9 LUFS、峰值 +2.5 dBTP、
      // 响度范围 20 LU，结果变成 -18.7 LUFS，比原来还小）。只压峰值也不行：这类视频平时说话很轻、偶尔一段很响，
      // 整体响度主要由响的那段决定，压住峰值就等于把响的那段压小了（实测只限幅 → -19.6 LUFS；loudnorm 动态模式 → -19.1）。
      // 做法：压缩器先缩小音量起伏 → 整体提升 → 限幅器压住峰值；提升多少先试算一两遍（只处理音频，每遍几秒）
      let gain = target - inI;
      const limited = parseFloat(m.input_tp) + gain > LOUD_TP;
      if (limited) {
        const lim = Math.pow(10, (LOUD_TP - 1) / 20); // 采样峰值再多留 1 dB，真峰值（采样之间的峰值）才能落在上限以内
        const chain = (g) => `acompressor=threshold=0.125:ratio=3:attack=5:release=150,volume=${g.toFixed(2)}dB,` +
          `alimiter=limit=${lim.toFixed(4)}:attack=5:release=50:level=0`;
        for (let k = 0; k < 2; k++) { // 实测两遍后与目标相差 1 LU 左右
          try {
            const logs = await run(['-hide_banner', '-i', input.path, '-vn', '-sn', '-dn',
              '-af', `${chain(gain)},loudnorm=I=${LOUD_TARGET}:TP=${LOUD_TP}:LRA=11:print_format=json`, '-f', 'null', '-'], info.durationSec);
            const got = parseFloat(parseLoudnormJSON(logs).input_i);
            if (!Number.isFinite(got) || Math.abs(got - target) < 0.7) break;
            gain = Math.min(MAX_GAIN_DB, gain + (target - got));
          } catch (e) {
            console.warn('响度试算失败，按估算值处理：', e);
            break;
          }
        }
        af.push(chain(gain));
      } else {
        af.push(`loudnorm=I=${target}:TP=${LOUD_TP}:LRA=${lra}` +
          `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
          // offset 是第一遍按 -14 目标算出的微调量，目标变了就不能再用
          (capped ? '' : `:offset=${m.target_offset}`) + ':linear=true:print_format=summary');
      }
      const dynamic = limited;
      plan.push(capped
        ? `音频：原片很安静（${loud.loudnessLUFS} LUFS），最多提升 ${MAX_GAIN_DB} dB 到 ${target} LUFS，避免把背景噪音一起放大；要达到 ${LOUD_TARGET} LUFS 建议重新录音，或在剪辑软件里降噪后再提升`
        : dynamic
          ? `音频：原片峰值过高（${loud.truePeakDBTP} dBTP）、音量起伏大（响度范围 ${loud.loudnessRangeLU} LU）：先压缩音量起伏，再整体提升 ${gain.toFixed(1)} dB、限幅，目标约 ${LOUD_TARGET} LUFS、峰值 ≤ ${LOUD_TP} dBTP。轻声和响声的差距会变小`
          : `音频：双遍 loudnorm，${loud.loudnessLUFS} → ${LOUD_TARGET} LUFS（真峰值 ≤ ${LOUD_TP} dBTP）`);
    }
    // 采样率：loudnorm 内部会升到 192kHz，所以做了响度统一也必须指定输出采样率
    let ar = null;
    if (fixes.resample && t.sampleRate && info.sampleRate !== t.sampleRate) {
      ar = t.sampleRate;
      plan.push(`音频：采样率 ${info.sampleRate} → ${ar} Hz`);
    } else if (af.length) {
      ar = [44100, 48000].includes(info.sampleRate) ? info.sampleRate : 48000;
    }
    const downmix = fixes.downmix && info.channels > (t.maxChannels || 2);
    if (downmix) plan.push(`音频：${info.channels} 声道 → 立体声`);

    if (af.length || ar || downmix || info.audioCodec !== 'AAC') {
      if (af.length) args.push('-af', af.join(','));
      if (ar) args.push('-ar', String(ar));
      if (downmix) args.push('-ac', '2');
      args.push('-c:a', 'aac', '-b:a', '192k');
      plan.push(`音频：编码为 AAC 192kbps${info.audioCodec !== 'AAC' ? `（原 ${info.audioCodec}）` : ''}`);
    } else {
      args.push('-c:a', 'copy');
      plan.push('音频：直接复制 AAC 流');
    }
  }

  const ext = opts.audioOnly ? '.m4a' : '.mp4';
  const outPath = '/out_' + Date.now() + ext;
  args.push('-movflags', '+faststart', outPath);
  if (!opts.audioOnly) plan.unshift('容器：输出 MP4');

  try {
    await run(args, outDuration, onProgress);
    const data = await ffmpeg.readFile(outPath);
    await ffmpeg.deleteFile(outPath);
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const outFile = new File([data.buffer], `${baseName}_${fixes.vertical ? 'vertical' : 'fixed'}${ext}`,
      { type: opts.audioOnly ? 'audio/mp4' : 'video/mp4' });
    return { file: outFile, args, plan };
  } finally {
    await input.cleanup();
  }
}

/**
 * 截取若干时间点的画面（PNG），用于修复前后画面对比。
 * 用 ffmpeg 而不是 <video> 截图，是因为浏览器播不了 MKV / HEVC / ProRes 等格式，ffmpeg 都能解。
 * 输出用 PNG 而不是 JPEG：ffmpeg.wasm 0.12 的 mjpeg 编码器配合 -ss 定位，在部分手机视频上会崩溃
 * （memory access out of bounds，实测华为 4K HEVC 原片及其转码结果），PNG / BMP 不受影响。
 * @param {File} file
 * @param {number[]} times 秒
 * @returns {Promise<string[]>} 图片的 blob URL（失败的为 null）
 */
export async function extractFrames(file, times, width = 480) {
  const input = await mountInput(file);
  const urls = [];
  try {
    for (const [i, t] of times.entries()) {
      const out = `/frame_${Date.now()}_${i}.png`;
      try {
        // -ss 放在 -i 前面是快速定位（跳到最近的关键帧再解码），对比画面足够用了
        await run(['-hide_banner', '-ss', String(t), '-i', input.path, '-frames:v', '1',
          '-vf', `scale=${width}:-2`, out], null, null);
        const data = await ffmpeg.readFile(out);
        await ffmpeg.deleteFile(out);
        urls.push(URL.createObjectURL(new Blob([data.buffer], { type: 'image/png' })));
      } catch (e) {
        console.warn('截帧失败', t, e);
        urls.push(null);
      }
    }
    return urls;
  } finally {
    await input.cleanup();
  }
}

/**
 * 生成一段“有问题”的测试视频（MKV 容器、720P、响度过大、可变帧率、5.1 声道），方便没有素材时体验流程。
 */
export async function makeTestVideo(seconds = 8) {
  const out = '/test_' + Date.now() + '.mkv';
  await run([
    '-hide_banner',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    // 随机丢帧 + 保留原时间戳 → 可变帧率；音量放大 → 响度过大
    '-vf', "select='not(eq(mod(n\\,7)\\,3))*not(eq(mod(n\\,11)\\,5))'", '-fps_mode', 'vfr',
    '-af', 'volume=12dB',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(loadedMode === 'mt' ? ['-threads', '4'] : []),
    '-ac', '6', '-c:a', 'aac', '-b:a', '256k', out,   // 5.1 声道 → 可测试“下混立体声”
  ], seconds, null);
  const data = await ffmpeg.readFile(out);
  await ffmpeg.deleteFile(out);
  return new File([data.buffer], 'test_720p_vfr_loud.mkv', { type: 'video/x-matroska' });
}
