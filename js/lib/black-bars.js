// ============================================================
// black-bars.js —— 检测视频画面里写死的黑边（左右黑边 / 上下黑边 / 四周黑边）
// 抽 5 帧（避开片头片尾淡入淡出）扫描四边纯黑像素，取所有有效帧的并集（只要任意一帧有画面就不算黑边），
// 映射到原视频显示尺寸并对齐偶数像素，供「画面黑边」体检规则和「裁切黑边」一键修复使用。
// ============================================================
import { hasWebCodecs, sampleFramesWebCodecs } from './webcodecs.js';
import { openVideo, sampleFrames } from './frame-sampler.js';
import { normalizeAspect } from './probe.js';

const SAMPLE_MAX_SIDE = 360;   // 抽帧分析画布长边上限（360px 足够准且速度极快）
const LUMA_DARK = 20;          // 亮度 ≤ 20 视为黑像素（兼容 YUV TV range 黑电平 16 及压缩噪点）
const LUMA_HARD = 42;          // 行/列里只要有像素亮度 ≥ 42 就视为存在有效画面（防止误裁暗景里的字幕/高光）
const DARK_ROW_RATIO = 0.985;  // 一行/一列中至少 98.5% 像素为黑且无明显亮点，才算黑边
const MIN_BAR_RATIO = 0.06;    // 单轴黑边合计占比 ≥ 6% 才报“有明显黑边”（忽略 1~2px 编码衬边）
const MIN_SIDE_RATIO = 0.02;   // 单侧黑边占比 ≥ 2% 才计入该侧黑边说明
const MIN_CONTENT_AREA = 0.1;  // 有效画面至少占原画面 10%，避免全黑/极暗视频被误裁空
const MIN_CROP_PX = 64;        // 裁切后宽高至少 64px

/** 分析单帧画布的有效内容边界；全黑帧返回 null（跳过） */
export function detectFrameBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, w, h).data;

  // 逐像素计算亮度并判断是否非黑
  const isRowDark = (y) => {
    let dark = 0;
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = base + x * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum >= LUMA_HARD) return false;
      if (lum <= LUMA_DARK) dark++;
    }
    return dark / w >= DARK_ROW_RATIO;
  };

  let top = 0;
  while (top < h && isRowDark(top)) top++;
  if (top >= h) return null; // 整帧全黑（如片头黑场）

  let bottom = h - 1;
  while (bottom > top && isRowDark(bottom)) bottom--;

  const isColDark = (x) => {
    let dark = 0;
    const span = bottom - top + 1;
    for (let y = top; y <= bottom; y++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum >= LUMA_HARD) return false;
      if (lum <= LUMA_DARK) dark++;
    }
    return dark / span >= DARK_ROW_RATIO;
  };

  let left = 0;
  while (left < w && isColDark(left)) left++;
  if (left >= w) return null;

  let right = w - 1;
  while (right > left && isColDark(right)) right--;

  return {
    left: left / w,
    right: (right + 1) / w,
    top: top / h,
    bottom: (bottom + 1) / h,
  };
}

/** 合并多帧有效边界（取并集）并换算成原视频像素坐标 */
export function summarizeBlackBars(boundsList, srcW, srcH) {
  const valid = boundsList.filter(Boolean);
  if (!valid.length || !srcW || !srcH) return { hasBlackBars: false, blackBars: null };

  const leftR = Math.min(...valid.map((b) => b.left));
  const rightR = Math.max(...valid.map((b) => b.right));
  const topR = Math.min(...valid.map((b) => b.top));
  const bottomR = Math.max(...valid.map((b) => b.bottom));

  // 对齐偶数像素（H.264 / YUV420P 要求偶数尺寸）
  const evenFloor = (v) => Math.max(0, Math.floor(v / 2) * 2);
  const evenCeil = (v, max) => Math.min(max, Math.ceil(v / 2) * 2);

  let x = evenFloor(leftR * srcW);
  let y = evenFloor(topR * srcH);
  let x2 = evenCeil(rightR * srcW, srcW);
  let y2 = evenCeil(bottomR * srcH, srcH);

  // 单侧极细黑边（< 2%）不做裁切，避免误伤正常边缘
  if (x / srcW < MIN_SIDE_RATIO) x = 0;
  if ((srcW - x2) / srcW < MIN_SIDE_RATIO) x2 = srcW;
  if (y / srcH < MIN_SIDE_RATIO) y = 0;
  if ((srcH - y2) / srcH < MIN_SIDE_RATIO) y2 = srcH;

  let w = Math.floor((x2 - x) / 2) * 2;
  let h = Math.floor((y2 - y) / 2) * 2;
  if (w < MIN_CROP_PX || h < MIN_CROP_PX) return { hasBlackBars: false, blackBars: null };

  const hBarRatio = (srcW - w) / srcW;
  const vBarRatio = (srcH - h) / srcH;
  const areaRatio = (w * h) / (srcW * srcH);
  if ((hBarRatio < MIN_BAR_RATIO && vBarRatio < MIN_BAR_RATIO) || areaRatio < MIN_CONTENT_AREA) {
    return { hasBlackBars: false, blackBars: null };
  }

  const hasLR = hBarRatio >= MIN_BAR_RATIO;
  const hasTB = vBarRatio >= MIN_BAR_RATIO;
  const sides = hasLR && hasTB ? '四周黑边' : hasLR ? '左右黑边' : '上下黑边';

  return {
    hasBlackBars: true,
    blackBars: {
      x, y, w, h, srcW, srcH,
      leftPct: Math.round((x / srcW) * 100),
      rightPct: Math.round(((srcW - x - w) / srcW) * 100),
      topPct: Math.round((y / srcH) * 100),
      bottomPct: Math.round(((srcH - y - h) / srcH) * 100),
      sides,
      aspectRatio: normalizeAspect(w, h),
    },
  };
}

/**
 * 检测视频中是否存在固定黑边。优先走 WebCodecs 顺序抽帧，失败则退回 <video> 抽帧。
 * 无法解码时不抛错，返回 { hasBlackBars: false, blackBars: null }。
 */
export async function detectBlackBars(file, info) {
  if (!info?.hasVideo || !info.width || !info.height) return { hasBlackBars: false, blackBars: null };
  const dur = info.durationSec || 0;
  const times = dur > 1
    ? [0.15, 0.32, 0.5, 0.68, 0.85].map((r) => +(dur * r).toFixed(2))
    : [Math.min(0.1, dur / 2)];

  const bounds = [];
  let sampled = false;

  if (hasWebCodecs()) {
    try {
      await sampleFramesWebCodecs(file, times, SAMPLE_MAX_SIDE, (canvas) => {
        bounds.push(detectFrameBounds(canvas));
      });
      sampled = true;
    } catch (e) {
      console.warn('WebCodecs 黑边抽帧失败，改用浏览器解码：', e);
      bounds.length = 0;
    }
  }

  if (!sampled) {
    const url = URL.createObjectURL(file);
    try {
      const src = await openVideo(url);
      await sampleFrames(src, times, SAMPLE_MAX_SIDE, (canvas) => {
        bounds.push(detectFrameBounds(canvas));
      });
    } catch (e) {
      console.warn('黑边检测跳过（浏览器无法解码）：', e);
      return { hasBlackBars: false, blackBars: null };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return summarizeBlackBars(bounds, info.width, info.height);
}
