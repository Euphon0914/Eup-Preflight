// ============================================================
// analyze.js —— 画面遮挡检查的判定逻辑（不碰界面，方便单独测试）
//
// 输入：每一帧识别到的文字框（换算成视频画面的百分比），平台的遮挡区域配置。
// 判定两种问题：
//   遮挡：元素被某个界面区域盖住的面积 ≥ 阈值（默认 30%）
//   裁切：视频铺满屏幕（videoFit = cover）时，元素落在被裁掉的画面边缘的面积 ≥ 阈值
// 相邻帧里“同一种元素被同一个区域挡住”合并成一个问题（例如第 12~15 秒的字幕）。
// ============================================================
import { intersect, zonesInVideo } from '../../lib/overlay-geometry.js';

export const CROP_ZONE = { id: '_crop', name: '画面边缘（会被裁掉）' };

const area = (r) => (r ? r.w * r.h : 0);

/** 时间写成“第 12 秒”“第 1 分 05 秒” */
export function fmtAt(t) {
  const s = Math.round(t);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
}
export function fmtRange(a, b) {
  const A = Math.round(a), B = Math.round(b);
  if (A === B) return `第 ${fmtAt(a)}`;
  return B < 60 ? `第 ${A}～${B} 秒` : `第 ${fmtAt(a)}～${fmtAt(b)}`; // “第 12～15 秒”
}

/**
 * 给出“往哪边移、移多少”的建议：在可见画面内，找移动距离最小、且移过去后不会再被任何界面区域挡住的位置
 * （只往上下左右一个方向移；候选位置是“刚好贴着某个区域边缘的外侧”）
 * @param {object} b      被挡住的元素（视频百分比）
 * @param {object} z      挡住它的区域
 * @param {object} vis    可见画面
 * @param {Array} zones   所有区域（判断新位置是否又被挡住）
 * @returns {{dir:string, pct:number, text:string}|null}
 */
export function moveAdvice(b, z, vis, zones = [z]) {
  const M = 1; // 多留 1% 余量
  const fits = (r) => r.x >= vis.x - 0.01 && r.y >= vis.y - 0.01 && r.x + r.w <= vis.x + vis.w + 0.01 && r.y + r.h <= vis.y + vis.h + 0.01;
  // 新位置要满足两条：
  //   ① 和每个界面区域的重叠不超过元素面积的 10%（很宽的字幕常常只擦到一点右侧按钮，可以接受）
  //   ② 移动方向上的“正前方/正后方”区域（在另一个方向上覆盖元素一半以上）要留出余量，避免挤进两个区域之间的窄缝
  const clear = (r, vertical) => zones.every((q) => {
    const hit = intersect(r, q);
    if (hit && area(hit) / area(r) >= 0.1) return false;
    const span = vertical ? (intersect({ ...r, y: q.y, h: q.h }, q)?.w || 0) / r.w : (intersect({ ...r, x: q.x, w: q.w }, q)?.h || 0) / r.h;
    if (span < 0.5) return true;
    const pad = M * 0.9;
    return !intersect(vertical ? { ...r, y: r.y - pad, h: r.h + pad * 2 } : { ...r, x: r.x - pad, w: r.w + pad * 2 }, q);
  });
  const cands = [];
  for (const q of zones) {
    cands.push({ dir: 'up', d: b.y + b.h - q.y + M }, { dir: 'down', d: q.y + q.h - b.y + M },
      { dir: 'left', d: b.x + b.w - q.x + M }, { dir: 'right', d: q.x + q.w - b.x + M });
  }
  const moved = ({ dir, d }) => ({ ...b, x: b.x + (dir === 'left' ? -d : dir === 'right' ? d : 0), y: b.y + (dir === 'up' ? -d : dir === 'down' ? d : 0) });
  const ok = cands.filter((c) => c.d > 0 && fits(moved(c)) && clear(moved(c), c.dir === 'up' || c.dir === 'down'))
    .sort((p, q) => p.d - q.d || ((p.dir === 'up' || p.dir === 'down') ? -1 : 1)); // 一样远时优先上下移
  if (!ok.length) return null;
  const o = ok[0];
  const pct = Math.max(1, Math.ceil(o.d));
  const name = { up: '上移', down: '下移', left: '左移', right: '右移' }[o.dir];
  return { dir: o.dir, pct, text: `${name}约 ${pct}% 画面${o.dir === 'up' || o.dir === 'down' ? '高度' : '宽度'}` };
}

/** 被裁切时：往画面中间移多少 */
function cropAdvice(b, vis) {
  const M = 1;
  const out = [];
  if (b.x < vis.x) out.push({ name: '右移', d: vis.x - b.x + M, axis: '宽度' });
  if (b.x + b.w > vis.x + vis.w) out.push({ name: '左移', d: b.x + b.w - (vis.x + vis.w) + M, axis: '宽度' });
  if (b.y < vis.y) out.push({ name: '下移', d: vis.y - b.y + M, axis: '高度' });
  if (b.y + b.h > vis.y + vis.h) out.push({ name: '上移', d: b.y + b.h - (vis.y + vis.h) + M, axis: '高度' });
  if (!out.length) return null;
  const o = out.sort((p, q) => q.d - p.d)[0];
  const pct = Math.max(1, Math.ceil(o.d));
  return { pct, text: `${o.name}约 ${pct}% 画面${o.axis}` };
}

/**
 * 把上下相邻的文字行合成一块（两行字幕要一起移动，建议才有意义）：
 * 水平方向重叠超过较窄一行的一半、上下间距不超过行高的 0.6 倍，就算同一块
 */
export function mergeTextBlocks(items) {
  const texts = items.filter((it) => it.kind === 'text').map((it) => ({ ...it, lines: 1 }));
  const others = items.filter((it) => it.kind !== 'text');
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h); // 负数表示上下有重叠
        if (ow < Math.min(a.w, b.w) * 0.5 || gap > Math.min(a.h / a.lines, b.h / b.lines) * 0.6) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
        const w = Math.max(a.x + a.w, b.x + b.w) - x, h = Math.max(a.y + a.h, b.y + b.h) - y;
        texts[i] = { ...a, x, y, w, h, text: `${top.text || ''} ${bottom.text || ''}`.trim(), lines: a.lines + b.lines };
        texts[i].label = y + h / 2 >= 55 ? '字幕' : '文字';
        texts.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return [...texts, ...others];
}

/**
 * 逐帧判定
 * @param {Array} frames   [{ t, items: [{ kind:'text', label, text, x, y, w, h }] }]（视频百分比）
 *                         文字行会先合并成块，结果缓存在 frame.blocks
 * @param {object} overlay 平台 overlay 配置
 * @param {number} aspect  视频宽 ÷ 高
 * @param {number} threshold 0~1，默认 0.3
 * @returns {{ geo, hits: Array, events: Array }}
 *   hits   每一帧的问题 { t, item, zone, ratio, advice }
 *   events 合并后的问题 { key, kind, label, zone, start, end, times, worst, ratio, advice, crop }
 */
export function analyzeFrames(frames, overlay, aspect, threshold = 0.3, interval = 1) {
  const geo = zonesInVideo(overlay, aspect);
  const vis = geo.visible;
  const cropped = vis.w < 99.9 || vis.h < 99.9;
  const hits = [];
  for (const f of frames) {
    for (const item of (f.blocks ||= mergeTextBlocks(f.items))) {
      const a = area(item);
      if (!a) continue;
      for (const z of geo.zones) {
        const ratio = area(intersect(item, z)) / a;
        if (ratio >= threshold) hits.push({ t: f.t, item, zone: z, ratio, advice: moveAdvice(item, z, vis, geo.zones) });
      }
      if (cropped) {
        const ratio = 1 - area(intersect(item, vis)) / a;
        if (ratio >= threshold) hits.push({ t: f.t, item, zone: CROP_ZONE, ratio, advice: cropAdvice(item, vis), crop: true });
      }
    }
  }

  // 合并：同一种元素（字幕 / 文字）+ 同一个区域，时间上相邻（允许中间漏识别一帧，即间隔不超过 2 个抽帧间隔）
  const groups = new Map();
  const sorted = [...hits].sort((p, q) => p.t - q.t);
  const events = [];
  for (const h of sorted) {
    const key = `${h.item.label}|${h.zone.id}`;
    const ev = groups.get(key);
    if (ev && h.t - ev.end <= interval * 2 + 0.01) {
      if (!ev.times.includes(h.t)) ev.times.push(h.t);
      ev.end = h.t;
      if (h.ratio > ev.worst.ratio) ev.worst = h;
    } else {
      const n = { key, kind: h.item.kind, label: h.item.label, zone: h.zone, crop: !!h.crop, start: h.t, end: h.t, times: [h.t], worst: h };
      groups.set(key, n);
      events.push(n);
    }
  }
  for (const ev of events) {
    ev.ratio = ev.worst.ratio;
    ev.advice = ev.worst.advice;
  }
  events.sort((p, q) => p.start - q.start);
  return { geo, hits, events };
}

/** 一个问题的通俗说明：title “第 12 秒的字幕被「底部标题和文案区」遮挡”，suggestion “上移约 8% 画面高度。” */
export function describeEvent(ev, platformName = '平台') {
  const when = fmtRange(ev.start, ev.end);
  const pct = Math.round(ev.ratio * 100);
  if (ev.crop) {
    return {
      title: `${when}的${ev.label}在画面边缘，会被裁掉`,
      reason: `${platformName}铺满屏幕播放时会裁掉画面边缘，这段${ev.label}有约 ${pct}% 落在被裁掉的部分。`,
      suggestion: ev.advice ? `${ev.advice.text}，放进画面中间。` : `把${ev.label}往画面中间放。`,
    };
  }
  return {
    title: `${when}的${ev.label}被「${ev.zone.name}」遮挡`,
    reason: `「${ev.zone.name}」（${ev.zone.desc || '平台界面'}）会盖住这段${ev.label}约 ${pct}% 的面积。`,
    suggestion: ev.advice ? `${ev.advice.text}。` : `把${ev.label}缩小或换个位置（往上下左右移都会碰到别的界面区域）。`,
  };
}
