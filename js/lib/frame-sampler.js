// ============================================================
// frame-sampler.js —— 用 <video> + <canvas> 按时间点抽帧
// 浏览器自己解码（含手机视频的旋转、HDR 显示转换），抽出的画面缩小后画到画布上，供识别用。
// ============================================================

/**
 * 打开一个只用于抽帧的隐藏 video
 * @returns {Promise<{video:HTMLVideoElement, width:number, height:number, duration:number}>}
 */
export function openVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const fail = () => reject(new Error('浏览器无法播放这个视频（编码或格式不支持），可以先在「技术体检 › 修复」里转成 MP4 再检查。'));
    v.onerror = fail;
    v.onloadeddata = async () => {
      if (!v.videoWidth || !v.videoHeight) return fail();
      try {
        const duration = await realDuration(v);
        resolve({ video: v, width: v.videoWidth, height: v.videoHeight, duration });
      } catch (e) { reject(e); }
    };
    v.src = url;
  });
}

/**
 * 有些文件（浏览器录制的 WebM、部分录屏）头部没写时长，video.duration 是 Infinity。
 * 这时跳到极远处，浏览器会扫描到结尾并更新真实时长，再跳回开头。
 */
async function realDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读不到视频时长')), 15000);
    const done = () => { if (Number.isFinite(v.duration)) { clearTimeout(timer); v.removeEventListener('durationchange', done); resolve(); } };
    v.addEventListener('durationchange', done);
    v.currentTime = 1e9;
  });
  v.currentTime = 0;
  return v.duration;
}

/** 跳到某个时间点，等画面真正更新 */
function seek(v, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`跳转到 ${t.toFixed(1)} 秒超时`)), 8000);
    v.addEventListener('seeked', () => {
      clearTimeout(timer);
      // 有的浏览器 seeked 时画面还没刷新，等下一帧（最多 150 毫秒）
      if (v.requestVideoFrameCallback) {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        v.requestVideoFrameCallback(fin);
        setTimeout(fin, 150);
      } else resolve();
    }, { once: true });
    v.currentTime = t;
  });
}

/** 抽帧的时间点：0 秒附近、之后每 interval 秒一帧，不超过时长 */
export function sampleTimes(duration, interval) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const out = [];
  for (let t = 0; t < duration - 0.05; t += interval) out.push(Math.round(Math.max(t, 0.05) * 1000) / 1000);
  return out.length ? out : [Math.min(0.05, duration / 2)];
}

/**
 * 依次抽帧。每一帧画到一张新画布上（长边不超过 maxSide），交给 onFrame 处理
 * @param {{video}} src           openVideo 的返回值
 * @param {number[]} times
 * @param {number} maxSide        画布长边上限（缩小后识别更快）
 * @param {(canvas, t, i) => Promise|void} onFrame  返回 Promise 时会等它（用来控制排队数量）
 * @param {() => boolean} canceled
 */
export async function sampleFrames(src, times, maxSide, onFrame, canceled = () => false) {
  const v = src.video;
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  for (let i = 0; i < times.length; i++) {
    if (canceled()) return;
    await seek(v, times[i]);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    await onFrame(c, times[i], i);
  }
}

/**
 * 取某个时间点的一帧（封面用，保留原始清晰度；长边超过 maxSide 才缩小）
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function grabFrame(src, t, maxSide = 4096) {
  await seek(src.video, Math.min(Math.max(0, t), Math.max(0, src.duration - 0.01)));
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src.video, 0, 0, c.width, c.height);
  return c;
}
