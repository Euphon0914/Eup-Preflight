// ============================================================
// hero-more.js —— 首屏下方的滚动效果
//   · 功能介绍：左边大字目录固定不动，右边四块随滚动经过；经过屏幕中间的那一块和目录对应项点亮，点目录滚到那一块
//   · 数据与隐私：“不上传。不联网。不追踪。随时删。”四行大字随滚动逐行点亮（变实、扫过荧光绿高光、右边说明淡入）
// 系统开了“减少动态效果”时：目录照常切换（不平滑滚动），四行大字直接全亮。
// ============================================================
import { $ } from './ui.js';
import { reducedMotion } from './motion.js';

function mountFeatures() {
  const panels = [...document.querySelectorAll('.feat-panel')];
  const nav = [...document.querySelectorAll('.feat-nav button')];
  const setActive = (i) => {
    nav.forEach((b, k) => b.classList.toggle('on', k === i));
    panels.forEach((p, k) => p.classList.toggle('on', k === i));
  };
  // 离屏幕中线最近的那一块算当前这一块（一次滚过好几块时也准，所以不用 IntersectionObserver）
  const update = () => {
    if (!panels[0]?.offsetParent) return; // 首屏没显示
    const mid = innerHeight / 2;
    const dist = panels.map((p) => { const r = p.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - mid); });
    setActive(dist.indexOf(Math.min(...dist)));
  };
  addEventListener('scroll', update, { passive: true }); // 浏览器每帧最多发一次 scroll，量 4 个矩形很便宜
  addEventListener('resize', update);
  update();
  nav.forEach((b, i) => b.addEventListener('click', () => panels[i].scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' })));
}

function mountPrivacyLines() {
  const box = $('.priv-rows');
  const lines = [...box.children];
  const update = () => {
    if (!box.offsetParent) return; // 首屏没显示
    if (reducedMotion()) { lines.forEach((l) => l.classList.add('lit')); return; }
    // 每一行的中线滚到屏幕 70% 高度以上就点亮（滚过去之后保持点亮，往回滚到下面再变暗）；
    // 已经滚到页面底部时全部点亮——屏幕较高时最后一行到不了 70% 线
    const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 4;
    lines.forEach((l) => { const r = l.getBoundingClientRect(); l.classList.toggle('lit', atEnd || r.top + r.height / 2 < innerHeight * 0.7); });
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

export function mountHeroMore() {
  mountFeatures();
  mountPrivacyLines();
}
