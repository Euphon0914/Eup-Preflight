// ============================================================
// glass-light.js —— 玻璃上的鼠标反光：鼠标在带 .lit 的玻璃块上移动时，一块淡淡的反光跟着走
// 只写 CSS 变量 --mx / --my（相对元素的百分比），反光本身由 base.css 的 .glass.lit 画出来；每帧最多写一次。
// 只在有鼠标的设备上开启（手机、平板上没有“悬停”，不需要）。
// ============================================================

export function mountGlassLight() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let target = null, x = 0, y = 0, queued = false;
  const flush = () => {
    queued = false;
    if (!target) return;
    const b = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${((x - b.left) / b.width) * 100}%`);
    target.style.setProperty('--my', `${((y - b.top) / b.height) * 100}%`);
  };
  document.addEventListener('pointermove', (e) => {
    target = e.target.closest?.('.glass.lit') || null;
    x = e.clientX; y = e.clientY;
    if (target && !queued) { queued = true; requestAnimationFrame(flush); }
  }, { passive: true });
}
