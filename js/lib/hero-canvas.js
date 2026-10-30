// ============================================================
// hero-canvas.js —— 首屏背景：几团缓慢漂移的柔光，其中一团是品牌色、轻轻跟着鼠标
// 只在首屏显示时运行（core/hero.js 调 start / stop）。为了不和视频分析抢资源：
//   · 分辨率最高 1.5 倍、帧率最高 30
//   · 标签页切到后台时暂停；离开首屏时停掉并清空画布
//   · 系统开了“减少动态效果”时只画一帧静态画面
// ============================================================

const MAX_DPR = 1.5;
const FRAME_MS = 1000 / 30;

// 每团光：位置在画布中心附近按李萨如曲线漂移（ax / ay 振幅、fx / fy 角速度，单位：画布比例 / 弧度每秒）
const BLOBS = [
  { ax: 0.32, ay: 0.22, fx: 0.11, fy: 0.15, px: 0.0, py: 1.2, r: 0.55, light: 'rgba(255, 255, 255, .9)', dark: 'rgba(92, 92, 100, .5)' },
  { ax: 0.28, ay: 0.30, fx: 0.09, fy: 0.07, px: 2.1, py: 0.4, r: 0.48, light: 'rgba(188, 188, 198, .55)', dark: 'rgba(64, 64, 72, .55)' },
  { ax: 0.36, ay: 0.26, fx: 0.06, fy: 0.12, px: 4.0, py: 2.6, r: 0.42, light: 'rgba(170, 170, 182, .45)', dark: 'rgba(74, 74, 84, .45)' },
  { ax: 0.30, ay: 0.24, fx: 0.08, fy: 0.10, px: 1.3, py: 3.3, r: 0.38, light: 'rgba(200, 240, 60, .30)', dark: 'rgba(200, 240, 60, .20)', brand: true },
];

let canvas = null, ctx = null, raf = 0, last = 0, t0 = 0, running = false;
const mouse = { x: 0.7, y: 0.4, has: false }; // 鼠标位置（画布比例）
const brandPos = { x: 0.7, y: 0.4 };          // 品牌色那团的实际位置（向鼠标缓动）

export const isRunning = () => running;

const isDark = () => document.documentElement.dataset.theme === 'dark'; // 顶栏切换键设的（js/core/prefs.js）
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  draw(performance.now());
}

function draw(now) {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height, S = Math.min(W, H), t = (now - t0) / 1000;
  const dark = isDark();
  ctx.clearRect(0, 0, W, H);
  for (const b of BLOBS) {
    let x = 0.5 + b.ax * Math.sin(t * b.fx + b.px), y = 0.5 + b.ay * Math.sin(t * b.fy + b.py);
    if (b.brand) {
      // 有鼠标时向鼠标靠（每帧走剩余距离的 4%），没有鼠标时照常漂移
      const tx = mouse.has ? mouse.x : x, ty = mouse.has ? mouse.y : y;
      brandPos.x += (tx - brandPos.x) * 0.04;
      brandPos.y += (ty - brandPos.y) * 0.04;
      x = brandPos.x; y = brandPos.y;
    }
    const r = S * b.r, cx = x * W, cy = y * H;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const c = dark ? b.dark : b.light;
    g.addColorStop(0, c);
    g.addColorStop(1, c.replace(/[\d.]+\)$/, '0)'));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (now - last < FRAME_MS) return; // 限制在 30 帧
  last = now;
  draw(now);
}

function onMove(e) { mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; mouse.has = true; }
function onVisibility() {
  cancelAnimationFrame(raf);
  if (!document.hidden && running && !still()) raf = requestAnimationFrame(frame);
}

export function start(el) {
  if (running) return;
  canvas = el;
  ctx = canvas.getContext('2d');
  running = true;
  t0 = performance.now();
  resize();
  addEventListener('resize', resize);
  addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  if (!still()) raf = requestAnimationFrame(frame);
}

export function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(raf);
  removeEventListener('resize', resize);
  removeEventListener('pointermove', onMove);
  document.removeEventListener('visibilitychange', onVisibility);
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0; // 释放画布内存
  ctx = null;
}
