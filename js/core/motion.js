// ============================================================
// motion.js —— 界面动效的统一入口：动效参数、常用动画（揭晓、数字滚动、依次出现、描边、飞入、光晕）
// 底层用 Motion（vendor/motion/motion.js，挂到 window.Motion）。
// 约定：元素在 CSS 里默认就是“最终状态”，初始状态只由这里的关键帧给出。所以：
//   · 系统开了“减少动态效果”：只保留很短的淡入，其余直接到最终状态
//   · Motion 没加载（没跑下载脚本、加载出错）：所有动画直接到最终状态，页面功能不受影响
// ============================================================

// ---------- 动效参数（和 base.css 里的 --dur-* / --ease 一致） ----------
export const DUR = { fast: 0.18, base: 0.32, emph: 0.6 };
export const EASE = [0.2, 0.8, 0.2, 1];
export const SPRING = {
  snappy: { type: 'spring', stiffness: 380, damping: 30 }, // 按钮、滑块
  soft: { type: 'spring', stiffness: 220, damping: 26 },   // 大块过渡
};

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const hasMotion = () => typeof window.Motion?.animate === 'function';

if (!hasMotion()) console.warn('动画库未加载，页面照常可用，只是没有动画');

const TRANSFORM_KEYS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY']);
const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** 不播动画，直接把元素放到关键帧的最后一帧（变换类属性一律回到原位） */
function settle(el, keyframes) {
  let resetTransform = false;
  for (const [k, v] of Object.entries(keyframes)) {
    if (TRANSFORM_KEYS.has(k)) resetTransform = true;
    else el.style[k] = String(last(v));
  }
  if (resetTransform) el.style.transform = '';
}

/**
 * 播放一段动画，返回结束时 resolve 的 Promise。
 * keyframes 写法同 Motion：{ opacity: [0, 1], y: [8, 0] }；options 如 { duration, ease, delay } 或 SPRING.soft
 */
export function animate(el, keyframes, options = {}) {
  if (!el) return Promise.resolve();
  if (!hasMotion()) { settle(el, keyframes); return Promise.resolve(); }
  if (reducedMotion()) {
    const { opacity, ...rest } = keyframes;
    settle(el, rest);
    if (opacity === undefined) return Promise.resolve();
    return window.Motion.animate(el, { opacity }, { duration: 0.15 }).finished.catch(() => {});
  }
  return window.Motion.animate(el, keyframes, { duration: DUR.base, ease: EASE, ...options }).finished.catch(() => {});
}

/**
 * 只播一次：同一个元素、同一个 key 只调用一次 run。
 * 各模块每次状态变化都会整块重渲染，用 key（文件 + 结论等）区分“真的变了”还是“只是刷新”。
 * @returns {boolean} 是否调用了 run
 */
export function reveal(el, key, run) {
  if (!el || el.dataset.revealKey === key) return false;
  el.dataset.revealKey = key;
  run();
  return true;
}

/** 数字从上一次的值（第一次为 0）滚动到 to */
export function countUp(el, to, { duration = DUR.emph + 0.2 } = {}) {
  if (!el) return;
  const from = Number(el.dataset.countFrom ?? 0);
  el.dataset.countFrom = String(to);
  if (!hasMotion() || reducedMotion() || from === to) { el.textContent = String(to); return; }
  el.textContent = String(from);
  window.Motion.animate(from, to, { duration, ease: EASE, onUpdate: (v) => { el.textContent = String(Math.round(v)); } });
}

/** 一组元素依次淡入上移（相邻间隔 gap 秒） */
export function stagger(els, { gap = 0.04, y = 8 } = {}) {
  [...els].forEach((el, i) => animate(el, { opacity: [0, 1], y: [y, 0] }, { ...SPRING.soft, delay: i * gap }));
}

/** SVG 里的线条一笔画出 */
export function drawStroke(svg) {
  if (!svg) return;
  svg.querySelectorAll('path, polyline, line').forEach((p) => {
    const len = p.getTotalLength?.() || 0;
    if (!len) return;
    p.style.strokeDasharray = String(len);
    if (!hasMotion() || reducedMotion()) { p.style.strokeDashoffset = '0'; return; }
    window.Motion.animate(p, { strokeDashoffset: [len, 0] }, { duration: DUR.emph, ease: EASE });
  });
}

/** FLIP：让 el 看起来从 from 这个矩形的位置和大小“飞”到它现在的位置 */
export function flyFrom(from, el, { spring = SPRING.soft } = {}) {
  if (!el || !from) return Promise.resolve();
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return Promise.resolve();
  const sx = from.width / to.width, sy = from.height / to.height;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return animate(el, { x: [dx, 0], y: [dy, 0], scaleX: [sx, 1], scaleY: [sy, 1], opacity: [0.6, 1] }, spring);
}

/** 一次品牌色光晕（样式见 base.css 的 .pulse） */
export function pulse(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove('pulse');
  void el.offsetWidth; // 重新触发动画
  el.classList.add('pulse');
  el.addEventListener('animationend', () => el.classList.remove('pulse'), { once: true });
}
