// ============================================================
// webcodecs.js —— 用浏览器 WebCodecs（有显卡就走硬件）做视频转码、截帧、音视频合并
// 主页面和 webcodecs-test.html 测速页共用。
// 解封装 / 封装由 mediabunny 负责，编解码交给浏览器的 VideoDecoder / VideoEncoder。
// 实测比 ffmpeg.wasm 快几十倍（4K60 HEVC → 1080P60：约 1.8x 实时，ffmpeg.wasm 约 0.04x）。
//
// 输出直接边写边存到浏览器的本地磁盘空间（OPFS），不在内存里攒整个文件，长视频也不会撑爆内存；
// 浏览器不支持 OPFS 时退回内存。
// ============================================================

// mediabunny 约 700KB，只在真正用到时才加载
let mb = null;
const lib = async () => (mb ||= await import('../../vendor/mediabunny/mediabunny.min.mjs'));

/** 浏览器是否有 WebCodecs 接口 */
export const hasWebCodecs = () => 'VideoEncoder' in self && 'VideoDecoder' in self;

const openInput = async (file) => {
  const { Input, BlobSource, ALL_FORMATS } = await lib();
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
};

// ============================================================
// 本地磁盘输出（OPFS：浏览器给每个网站的私有文件夹，用户看不到，清除网站数据会一起删除）
// ============================================================
export const hasOPFS = () => !!navigator.storage?.getDirectory;
const opfsDir = async (name) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });

/**
 * 创建输出目标。
 * @param {'tmp'|'outputs'} dirName tmp 放中间文件；outputs 放最终结果（处理历史引用这里的文件）
 * @param {string} fileName OPFS 里的文件名（需唯一）
 * @returns {{target, onDisk:boolean, finish:(displayName:string)=>Promise<File>, remove:()=>Promise<void>, dir:string, name:string}}
 */
export async function createOutputTarget(dirName, fileName) {
  const { StreamTarget, BufferTarget } = await lib();
  if (hasOPFS()) {
    try {
      const dir = await opfsDir(dirName);
      const fh = await dir.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      return {
        target: new StreamTarget(writable, { chunked: true }), // 分块写盘，不在内存里攒整个文件
        onDisk: true, dir: dirName, name: fileName,
        // 用 OPFS 文件构造 File 只是引用，不会把数据读进内存
        finish: async (displayName) => new File([await fh.getFile()], displayName, { type: 'video/mp4' }),
        remove: async () => { try { await dir.removeEntry(fileName); } catch (e) { /* 已不存在 */ } },
      };
    } catch (e) {
      console.warn('OPFS 不可用，改为内存输出：', e);
    }
  }
  const target = new BufferTarget();
  return {
    target, onDisk: false, dir: null, name: fileName,
    finish: async (displayName) => new File([target.buffer], displayName, { type: 'video/mp4' }),
    remove: async () => {},
  };
}

/** 读取 OPFS 里的文件（处理历史用） */
export async function readOPFSFile(dirName, fileName, displayName, type = 'video/mp4') {
  const fh = await (await opfsDir(dirName)).getFileHandle(fileName);
  return new File([await fh.getFile()], displayName || fileName, { type });
}

/** 删除 OPFS 里的文件；keep 为要保留的文件名集合（不传则全删） */
export async function cleanOPFSDir(dirName, keep = null) {
  if (!hasOPFS()) return;
  try {
    const dir = await opfsDir(dirName);
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    for (const name of names) if (!keep || !keep.has(name)) await dir.removeEntry(name).catch(() => {});
  } catch (e) {
    console.warn('清理 OPFS 失败：', e);
  }
}
export const removeOPFSFile = async (dirName, fileName) => {
  try { await (await opfsDir(dirName)).removeEntry(fileName); } catch (e) { /* 已不存在 */ }
};

// MP4 的“快速启动”需要把整个文件攒在内存里再写；写盘时改为把索引放在文件末尾（上传、本地播放都不受影响）
const mp4Format = async (onDisk) => new (await lib()).Mp4OutputFormat({ fastStart: onDisk ? false : 'in-memory' });

// ============================================================
// 读信息
// ============================================================
/**
 * 读取视频基本信息（显示尺寸已考虑旋转），并判断这个浏览器能否解码
 * @returns {{w,h,codec,duration,fps,kbps,audio,canDecode}}
 */
export async function readVideoMeta(file) {
  const input = await openInput(file);
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  if (!v) throw new Error('没有视频轨');
  const stats = await v.computePacketStats(300); // 只看前 300 个包估算帧率和码率，速度快
  return {
    w: v.displayWidth, h: v.displayHeight, codec: v.codec,
    duration: await input.computeDuration(),
    fps: stats.averagePacketRate, kbps: Math.round(stats.averageBitrate / 1000),
    audio: a ? `${a.codec} · ${a.sampleRate} Hz · ${a.numberOfChannels} 声道` : '无',
    audioCodec: a?.codec ?? null,
    canDecode: await v.canDecode(),
  };
}

/** 检查这个文件能不能用 WebCodecs 处理；不能时返回原因 */
export async function checkWebCodecs(file) {
  if (!hasWebCodecs()) return { ok: false, reason: '浏览器不支持 WebCodecs' };
  try {
    const m = await readVideoMeta(file);
    return m.canDecode ? { ok: true, meta: m } : { ok: false, reason: `浏览器无法解码 ${m.codec}` };
  } catch (e) {
    return { ok: false, reason: '读取失败：' + (e.message || e) };
  }
}

// MP4 能直接装下（不重新编码）的视频 / 音频编码
const MP4_VIDEO = new Set(['avc', 'hevc', 'vp9', 'av1']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac']);

/** 视频 / 音频能否不重新编码、直接复制进 MP4（只改音频 / 封装时用）。没有音轨时 audio 为 true */
export async function canCopyToMp4(file) {
  try {
    const m = await readVideoMeta(file);
    return { video: MP4_VIDEO.has(m.codec), audio: !m.audioCodec || MP4_AUDIO.has(m.audioCodec) };
  } catch (e) {
    return { video: false, audio: false };
  }
}

// ============================================================
// 横屏转竖屏：每帧画在画布上（背景 = 同一画面铺满 + 模糊 + 压暗，前景 = 原画面完整居中）
// ============================================================
export const VERTICAL_W = 1080, VERTICAL_H = 1920;

function makeVerticalProcessor(W, H) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // 背景先画在 1/8 大小的小画布上再模糊、放大：效果几乎一样，计算量少几十倍
  const small = new OffscreenCanvas(Math.round(W / 8), Math.round(H / 8));
  const sctx = small.getContext('2d');
  sctx.filter = 'blur(4px)';
  return (sample) => {
    sctx.clearRect(0, 0, small.width, small.height);
    sample.drawWithFit(sctx, { fit: 'cover' });          // 铺满裁切（已考虑旋转）
    ctx.filter = 'brightness(0.75)';                     // 背景压暗一点，让前景更突出
    ctx.drawImage(small, 0, 0, W, H);
    ctx.filter = 'none';
    sample.drawWithFit(ctx, { fit: 'contain' });         // 前景完整显示、居中
    return canvas;
  };
}

// ============================================================
// 转码
// ============================================================
/**
 * 缩放 / 横屏转竖屏 + 固定帧率 + H.264 目标码率，输出 MP4。音频是 AAC 就直接复制，否则转 AAC。
 * @param {File} file
 * @param {object} p
 *   width/height 输出显示尺寸（偶数）；vertical=true 时改为横屏转竖屏（输出 1080×1920，忽略 width/height）；
 *   fps 不传则保持原帧率和时间轴；kbps 目标码率；trimEnd 只保留前 N 秒；
 *   noAudio=true 只输出视频（音频另由 ffmpeg 处理后再合并）；hw 编码偏好；
 *   out: { dir:'tmp'|'outputs', name, displayName } 输出位置
 * @param {(x:number)=>void} onProgress 0~1
 * @param {{onConversion?: (c)=>void}} hooks 拿到 Conversion 对象（用于取消）
 * @returns {Promise<{file: File, dropped: string[], out}>}
 */
export async function transcodeWithWebCodecs(file, p, onProgress, hooks = {}) {
  const { Output, Conversion } = await lib();
  const input = await openInput(file);
  const v = await input.getPrimaryVideoTrack();
  // 防护：输出方向必须和输入的显示方向一致，否则 fit: 'fill' 会把画面拉伸变形
  if (!p.vertical && v && (p.width > p.height) !== (v.displayWidth > v.displayHeight) && p.width !== p.height) {
    throw new Error(`输出尺寸 ${p.width}×${p.height} 与输入显示方向 ${v.displayWidth}×${v.displayHeight} 不一致，已停止以免画面变形`);
  }
  const out = await createOutputTarget(p.out?.dir || 'tmp', p.out?.name || `wc_${Date.now()}.mp4`);
  const output = new Output({ format: await mp4Format(out.onDisk), target: out.target });
  const size = p.vertical
    ? { process: makeVerticalProcessor(VERTICAL_W, VERTICAL_H), processedWidth: VERTICAL_W, processedHeight: VERTICAL_H }
    : { width: p.width, height: p.height, fit: 'fill' };
  let conv;
  try {
    conv = await Conversion.init({
      input, output,
      tracks: 'primary',
      video: {
        ...size,
        ...(p.fps ? { frameRate: p.fps } : {}), // 指定帧率 → 输出固定帧率（可变帧率源也会被规整）；不指定则保持原时间轴
        codec: 'avc',
        // 注意：实测浏览器编码器（硬件和软件）都不理会 constant 码率模式，简单画面实际码率会比这里低
        bitrate: p.kbps * 1000,
        hardwareAcceleration: p.hw || 'no-preference',
        forceTranscode: true,
      },
      audio: p.noAudio ? { discard: true } : { codec: 'aac' }, // 源已是 AAC 时直接复制，不重新编码
      ...(p.trimEnd ? { trim: { end: p.trimEnd } } : {}),
    });
    if (!conv.isValid) {
      throw new Error('WebCodecs 无法转换：' + conv.discardedTracks.map((d) => `${d.track.type} 轨（${d.reason}）`).join('，'));
    }
    hooks.onConversion?.(conv);
    if (onProgress) conv.onProgress = (x) => onProgress(x);
    await conv.execute();
  } catch (e) {
    await out.remove();
    throw e;
  }
  return {
    file: await out.finish(p.out?.displayName || file.name.replace(/\.[^.]+$/, '') + '.mp4'),
    dropped: conv.discardedTracks.filter((d) => d.reason !== 'discarded_by_user').map((d) => `${d.track.type} 轨被丢弃（${d.reason}）`),
    out,
  };
}

// ============================================================
// 合并：视频轨 + 音频轨直接复制进 MP4（不重新编码），边读边写盘
// ============================================================
/**
 * @param {File} videoFile 取它的视频轨（原片或 WebCodecs 输出）
 * @param {File|null} audioFile 取它的音频轨（ffmpeg 处理后的 m4a，或原片）；null 表示不要音频
 * @param {{trimEnd?:number, duration?:number, out:{dir,name,displayName}}} opts
 * @returns {Promise<{file: File, out}>}
 */
export async function muxTracks(videoFile, audioFile, opts, onProgress) {
  const M = await lib();
  const vt = await (await openInput(videoFile)).getPrimaryVideoTrack();
  const at = audioFile ? await (await openInput(audioFile)).getPrimaryAudioTrack() : null;
  if (!vt || !MP4_VIDEO.has(vt.codec)) throw new Error(`视频编码 ${vt?.codec ?? '未知'} 不能直接装进 MP4`);
  if (at && !MP4_AUDIO.has(at.codec)) throw new Error(`音频编码 ${at.codec} 不能直接装进 MP4`);

  const out = await createOutputTarget(opts.out.dir, opts.out.name);
  const output = new M.Output({ format: await mp4Format(out.onDisk), target: out.target });
  const vs = new M.EncodedVideoPacketSource(vt.codec);
  output.addVideoTrack(vs, { rotation: vt.rotation }); // 保留手机视频的旋转信息
  let as = null;
  if (at) { as = new M.EncodedAudioPacketSource(at.codec); output.addAudioTrack(as); }
  try {
    await output.start();
    const vcfg = await vt.getDecoderConfig();
    const acfg = at ? await at.getDecoderConfig() : null;
    const vIt = new M.EncodedPacketSink(vt).packets();
    const aIt = at ? new M.EncodedPacketSink(at).packets() : null;
    const end = opts.trimEnd ?? Infinity;
    const total = opts.duration || 1;
    let v = await vIt.next(), a = aIt ? await aIt.next() : { done: true };
    let vFirst = true, aFirst = true, vStop = false;
    // 两条轨按时间交错写入（MP4 要求音视频交错存放）
    while (!(v.done || vStop) || !a.done) {
      const takeVideo = !(v.done || vStop) && (a.done || v.value.timestamp <= a.value.timestamp);
      if (takeVideo) {
        // 截断：遇到第一个超出结束时间的包就停（按解码顺序停，后面依赖它的 B 帧也一起丢掉，不会花屏）
        if (v.value.timestamp >= end) { vStop = true; continue; }
        await vs.add(v.value, vFirst ? { decoderConfig: vcfg } : undefined);
        vFirst = false;
        onProgress?.(Math.min(1, v.value.timestamp / total));
        v = await vIt.next();
      } else {
        if (a.value.timestamp < end) {
          await as.add(a.value, aFirst ? { decoderConfig: acfg } : undefined);
          aFirst = false;
        }
        a = await aIt.next();
      }
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    await out.remove();
    throw e;
  }
  return { file: await out.finish(opts.out.displayName), out };
}

// ============================================================
// 截帧
// ============================================================
/**
 * 截取若干时间点的画面（PNG），用于前后对比。比 ffmpeg.wasm 快得多（4K HEVC 原片：约 12 秒 → 1 秒以内）。
 * 旋转信息会自动应用（输出为显示方向）。
 * @param {File} file
 * @param {number[]} times 秒，需按从小到大排列
 * @param {number} width 输出宽度，高度按比例
 * @returns {Promise<(string|null)[]>} 图片 blob URL，取不到的为 null
 */
/**
 * 按时间点依次取帧（画面遮挡检查用）：从头到尾顺序解码一遍，比 <video> 逐个跳转快很多——
 * 跳转每次都要从前一个关键帧重新解码，画面复杂、CPU 忙的时候每帧要 1 秒左右。
 * 画布长边不超过 maxSide；会按视频的旋转信息摆正。
 * @param {(canvas, t, i) => Promise|void} onFrame  返回 Promise 时会等它（控制排队数量）
 * @returns {Promise<{width:number, height:number}>} 抽帧画布的尺寸
 */
export async function sampleFramesWebCodecs(file, times, maxSide, onFrame, canceled = () => false) {
  const { CanvasSink } = await lib();
  const input = await openInput(file);
  const v = await input.getPrimaryVideoTrack();
  if (!v || !(await v.canDecode())) throw new Error('浏览器无法解码该视频');
  const W = v.displayWidth, H = v.displayHeight;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const width = Math.round(W * scale), height = Math.round(H * scale);
  const sink = new CanvasSink(v, { width, height, fit: 'fill' });
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (canceled()) break;
    if (wc) await onFrame(wc.canvas, times[i], i);
    i++;
  }
  return { width, height };
}

export async function captureFramesWebCodecs(file, times, width = 480) {
  const { CanvasSink } = await lib();
  const input = await openInput(file);
  const v = await input.getPrimaryVideoTrack();
  if (!v || !(await v.canDecode())) throw new Error('浏览器无法解码该视频');
  const sink = new CanvasSink(v, { width });
  const urls = [];
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (!wc) { urls.push(null); continue; }
    const c = wc.canvas;
    const blob = c.convertToBlob
      ? await c.convertToBlob({ type: 'image/png' })                  // OffscreenCanvas
      : await new Promise((r) => c.toBlob(r, 'image/png'));          // 普通 canvas
    urls.push(blob ? URL.createObjectURL(blob) : null);
  }
  return urls;
}
