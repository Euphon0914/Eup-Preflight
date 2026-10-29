// ============================================================
// crop.js —— 封面适配的裁切和检查逻辑（不碰界面，方便单独测试）
//
// 坐标：原图上的框都用像素 { x, y, w, h }；角标（zones）用“裁切后封面”的百分比。
// 检查四件事：主体有没有被裁掉 / 被角标挡住；标题文字有没有被裁掉 / 被角标挡住；导出时要放大多少（清晰度）。
// ============================================================
import { intersect, zonesInVideo } from '../../lib/overlay-geometry.js';
import { moveAdvice } from '../occlusion/analyze.js';

const area = (r) => (r ? r.w * r.h : 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 裁切框限制在原图范围内 */
export function clampCrop(c, W, H) {
  const w = Math.min(c.w, W), h = Math.min(c.h, H);
  return { x: clamp(c.x, 0, W - w), y: clamp(c.y, 0, H - h), w, h };
}

/**
 * 默认裁切：这个比例下能取到的最大框，中心尽量对准主体中心
 * @param {number} W 原图宽  @param {number} H 原图高
 * @param {number[]} ratio [宽, 高]
 * @param {object} subject 主体框（像素），不传则居中
 */
export function defaultCrop(W, H, ratio, subject) {
  const r = ratio[0] / ratio[1];
  let w = W, h = W / r;
  if (h > H) { h = H; w = H * r; }
  const cx = subject ? subject.x + subject.w / 2 : W / 2;
  const cy = subject ? subject.y + subject.h / 2 : H / 2;
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H);
}

/** 这个封面比例显示时会盖在上面的角标（裁切后封面的百分比） */
export function zonesFor(ratioCfg, platform) {
  if (ratioCfg.zonesFrom === 'overlay') {
    // 全屏封面：用播放页的界面遮挡区域，换算到这个比例的画面上
    return platform?.overlay ? zonesInVideo(platform.overlay, ratioCfg.ratio[0] / ratioCfg.ratio[1]).zones : [];
  }
  return ratioCfg.zones || [];
}

/** 原图像素 → 裁切后封面的百分比 */
const toCrop = (b, c) => ({ x: ((b.x - c.x) / c.w) * 100, y: ((b.y - c.y) / c.h) * 100, w: (b.w / c.w) * 100, h: (b.h / c.h) * 100 });
/** 元素在画面里的大致位置，用于说明“顶部的标题文字” */
const where = (b, H) => { const cy = (b.y + b.h / 2) / H; return cy < 0.34 ? '顶部' : cy > 0.66 ? '底部' : '中间'; };

/**
 * 检查一个封面比例
 * @param {{W:number, H:number, crop:object, subject:object, texts:Array, ratioCfg:object, zones:Array, threshold?:number}} o
 *   texts 原图上识别到的文字块（像素）
 * @returns {Array<{kind:string, title:string, reason:string, suggestion:string}>} 问题列表，空数组表示没问题
 */
export function checkCrop({ W, H, crop, subject, texts = [], ratioCfg, zones = [], threshold = 0.3 }) {
  const issues = [];
  const full = { x: 0, y: 0, w: 100, h: 100 };
  const cropPx = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };

  // ① 主体
  if (subject && area(subject)) {
    const cut = 1 - area(intersect(subject, cropPx)) / area(subject);
    if (cut >= 0.1) {
      const tooBig = subject.w > crop.w * 1.01 || subject.h > crop.h * 1.01;
      issues.push({
        kind: 'subject-cut',
        title: `主体被裁掉约 ${Math.round(cut * 100)}%`,
        reason: `框出的主体${tooBig ? `比 ${ratioCfg.ratio.join(':')} 的画面还${subject.w > crop.w ? '宽' : '高'}` : '有一部分在裁切范围外'}，这个比例里显示不全。`,
        suggestion: tooBig ? '把主体框缩小到最重要的部分，或换一帧主体更集中的画面。' : '拖动这个比例的预览图，把主体放进画面里。',
      });
    }
    const sIn = toCrop(subject, crop);
    for (const z of zones) {
      const ov = area(intersect(sIn, z)) / area(sIn);
      if (ov >= threshold) {
        issues.push({
          kind: 'subject-zone',
          title: `主体被「${z.name}」挡住约 ${Math.round(ov * 100)}%`,
          reason: `「${z.name}」（${z.desc || '平台角标'}）会盖在封面上。`,
          suggestion: '拖动预览图让主体避开这个位置，或把主体框缩小到最重要的部分。',
        });
      }
    }
  }

  // ② 标题文字
  texts.forEach((t) => {
    const pos = t.manual ? `${where(t, H)}标记的文字` : `${where(t, H)}的标题文字`;
    const cut = 1 - area(intersect(t, cropPx)) / area(t);
    if (cut >= 0.999) {
      issues.push({
        kind: 'text-hidden', title: `${pos}完全看不到`,
        reason: `这段文字整个落在 ${ratioCfg.ratio.join(':')} 的裁切范围外。`,
        suggestion: t.w > crop.w ? '标题比这个比例的画面还宽，建议缩短标题或分成两行。' : '拖动预览图把文字放进来；如果这段字不重要可以忽略。',
      });
      return;
    }
    if (cut >= 0.1) {
      issues.push({
        kind: 'text-cut', title: `${pos}被裁掉约 ${Math.round(cut * 100)}%`,
        reason: `这个比例只能显示原图的一部分，文字${t.w > crop.w * 1.01 ? '比画面还宽' : '有一部分在裁切范围外'}。`,
        suggestion: t.w > crop.w * 1.01 ? '标题比这个比例的画面还宽，建议缩短标题或分成两行，放在画面中间。' : '拖动预览图把文字完整放进来，或把标题往画面中间放。',
      });
    }
    const tIn = toCrop(t, crop);
    for (const z of zones) {
      const ov = area(intersect(tIn, z)) / area(tIn);
      if (ov >= threshold) {
        const adv = moveAdvice(tIn, z, full, zones);
        issues.push({
          kind: 'text-zone', title: `${pos}被「${z.name}」挡住约 ${Math.round(ov * 100)}%`,
          reason: `「${z.name}」（${z.desc || '平台角标'}）会盖在封面上。`,
          suggestion: adv ? `把标题${adv.text}，避开「${z.name}」。` : `把标题避开「${z.name}」所在的位置。`,
        });
      }
    }
  });

  // ③ 清晰度：裁出来的画面比导出尺寸小太多，放大后会发糊
  const scale = ratioCfg.size[0] / crop.w;
  if (scale > 1.25) {
    issues.push({
      kind: 'resolution', scale, title: `清晰度不够（要放大 ${scale.toFixed(1)} 倍）`,
      reason: `裁出来的画面只有 ${Math.round(crop.w)}×${Math.round(crop.h)}，导出 ${ratioCfg.size.join('×')} 时要放大，会有点糊。`,
      suggestion: '换一张更清晰的原图，或从更高清的视频里截帧。',
    });
  }
  return issues;
}
