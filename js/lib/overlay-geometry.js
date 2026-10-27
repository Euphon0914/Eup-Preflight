// ============================================================
// overlay-geometry.js —— 界面遮挡区域的坐标换算
//
// 配置里的遮挡区域（zones）都是相对【整张手机截图】的百分比。
// 但视频不一定铺满屏幕：播放区域（videoArea）可能只占屏幕的一部分，
// 视频在播放区域里按 videoFit 摆放（contain 完整显示留黑边 / cover 铺满裁掉多余部分）。
// 这里把“屏幕上的区域”换算成“视频画面上的区域”，校准页和画面遮挡检查共用。
// 所有矩形都是 { x, y, w, h }，单位为百分比（0~100），x、y 为左上角。
// ============================================================

/** 播放区域默认是整个屏幕 */
export const FULL_AREA = Object.freeze({ x: 0, y: 0, w: 100, h: 100 });

/** 写进配置文件的 overlay 字段说明（校准页导出时使用） */
export const OVERLAY_NOTE =
  '界面遮挡区域：x / y / w / h 都是相对于【整张手机截图】宽、高的百分比（0~100），x、y 是矩形左上角。' +
  'screenAspect 是校准用截图的宽 ÷ 高；videoArea 是视频播放区域（不写表示整个屏幕）；' +
  'videoFit 表示视频在播放区域里的摆放方式：contain = 完整显示、居中，不够的地方留黑边；cover = 铺满播放区域，多出来的部分被裁掉。' +
  'cover 只用于比例接近屏幕的视频：要裁掉的部分超过 coverMaxCrop（默认 0.25，即 25%）时改按 contain 摆放（横屏视频通常是上下留黑边）。' +
  '建议用 calibrate.html 对着真实截图校准后导出。';

/** 两个矩形的交集；没有交集返回 null */
export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/**
 * 这个比例的视频实际怎么摆：配置是 cover 时，如果要裁掉的部分太多（超过 coverMaxCrop），改成 contain
 * （例如抖音铺满播放竖屏视频，但横屏视频是上下留黑边完整显示）
 */
export function fitFor(ov, videoAspect) {
  if (ov?.videoFit !== 'cover') return 'contain';
  const sa = ov?.screenAspect || 9 / 19.5;
  const a = ov?.videoArea || FULL_AREA;
  const areaAspect = (a.w / a.h) * sa;
  const keep = Math.min(videoAspect, areaAspect) / Math.max(videoAspect, areaAspect); // 铺满后保留的比例
  return 1 - keep <= (ov.coverMaxCrop ?? 0.25) ? 'cover' : 'contain';
}

/**
 * 视频画面在屏幕上的位置（屏幕百分比）。cover 时会超出播放区域（超出部分看不到）
 * @param {object} ov          平台的 overlay 配置
 * @param {number} videoAspect 视频宽 ÷ 高（竖屏 9:16 = 0.5625）
 */
export function videoRectOnScreen(ov, videoAspect) {
  const sa = ov?.screenAspect || 9 / 19.5;
  const a = ov?.videoArea || FULL_AREA;
  // 以“屏幕高 = 1、屏幕宽 = sa”为单位计算，避免百分比在横竖两个方向上单位不同
  const AW = (a.w / 100) * sa, AH = a.h / 100;
  const k = (fitFor(ov, videoAspect) === 'cover' ? Math.max : Math.min)(AW / videoAspect, AH); // 视频高度
  const vw = videoAspect * k, vh = k;
  const x = (a.x / 100) * sa + (AW - vw) / 2, y = a.y / 100 + (AH - vh) / 2;
  return { x: (x / sa) * 100, y: y * 100, w: (vw / sa) * 100, h: vh * 100 };
}

/** 屏幕百分比 → 视频画面百分比 */
function toVideo(r, v) {
  return { x: ((r.x - v.x) / v.w) * 100, y: ((r.y - v.y) / v.h) * 100, w: (r.w / v.w) * 100, h: (r.h / v.h) * 100 };
}

/**
 * 把遮挡区域换算到视频画面上
 * @returns {{ screen: object, visible: object, zones: Array }}
 *   screen  视频在屏幕上的位置（屏幕百分比）
 *   visible 视频里能被看到的部分（视频百分比；contain 时是整个画面，cover 时两边或上下被裁掉）
 *   zones   每个遮挡区域在视频画面上的位置（视频百分比），只保留和可见画面有重叠的区域
 */
export function zonesInVideo(ov, videoAspect) {
  const v = videoRectOnScreen(ov, videoAspect);
  const vis = intersect(v, ov?.videoArea || FULL_AREA) || v;
  const zones = [];
  for (const z of ov?.zones || []) {
    const hit = intersect(z, vis);
    if (hit) zones.push({ ...z, ...toVideo(hit, v) });
  }
  return { screen: v, visible: toVideo(vis, v), zones };
}
