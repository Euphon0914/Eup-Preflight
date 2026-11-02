// ============================================================
// cursor-glow.js —— 工作台背景：一团品牌色柔光缓缓跟着鼠标，和首屏 Canvas 里那团（js/lib/hero-canvas.js）一样
//   首屏有 Canvas 自己画，这里只在工作台显示（body.on-hero 时 CSS 把它藏起来）。
//   不用 Canvas：光斑是一个固定定位的 div（#cursorGlow，样式在 base.css），只改 transform，不重绘；
//   从首屏进来时从 Canvas 那团光当时的位置接着走；鼠标停下、光斑追上后就停止动画，不占资源。
//   只在有鼠标的设备上开启；系统开了“减少动态效果”时不开。
// ============================================================
import { brandPoint, isRunning } from '../lib/hero-canvas.js';

const EASE = 0.04;          // 每 1/30 秒走剩余距离的 4%，和首屏那团光的跟随速度一样
const FRAME_MS = 1000 / 30;

export function mountCursorGlow() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const glow = document.getElementById('cursorGlow');
  let x = 0, y = 0, tx = 0, ty = 0, raf = 0, last = 0, seen = false;

  const frame = (now) => {
    if (isRunning()) {
      // 首屏：跟着 Canvas 里那团光走（这时光斑是藏着的），回到工作台时位置正好接上
      const p = brandPoint();
      x = p.x * innerWidth; y = p.y * innerHeight;
    } else {
      // 按实际经过的时间折算缓动，帧率高低不影响跟随速度
      const k = 1 - Math.pow(1 - EASE, Math.min(now - last, 100) / FRAME_MS);
      x += (tx - x) * k; y += (ty - y) * k;
    }
    last = now;
    glow.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(frame) : 0;
  };

  document.addEventListener('pointermove', (e) => {
    tx = e.clientX; ty = e.clientY;
    if (!seen) { seen = true; x = tx; y = ty; glow.classList.add('on'); }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }, { passive: true });
}
