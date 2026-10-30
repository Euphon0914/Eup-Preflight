// ============================================================
// seg-slider.js —— 分段控件和步骤导航的“选中块”：切换时滑到新选项上，而不是直接跳过去
// 做法：容器里垫一个绝对定位的 .seg-thumb，尺寸和位置直接设成当前选项的（不做动画），
// 再用 transform 从旧位置滑过来（FLIP）。选中块画背景和阴影，选项本身只改文字颜色（见 base.css）。
// 选项是 innerHTML 重新生成的也没关系：观察到选中块被冲掉了就重新放一个。
// ============================================================
import { animate, SPRING } from './motion.js';

/**
 * @param {Element} container 分段控件 / 导航
 * @param {string} selector 选项（带 .on 的那个是当前选中）
 * @returns {() => void} 解绑
 */
export function attachSegSlider(container, selector) {
  if (!container) return () => {};
  container.classList.add('has-thumb');
  const thumb = document.createElement('span');
  thumb.className = 'seg-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  let prev = null; // 上一次的位置 { x, y }

  const place = (anim) => {
    if (!thumb.isConnected) container.prepend(thumb);
    const on = [...container.querySelectorAll(selector)].find((b) => b.classList.contains('on') && !b.hidden);
    if (!on || !container.offsetParent || !on.offsetWidth) { thumb.style.opacity = '0'; prev = null; return; }
    const x = on.offsetLeft, y = on.offsetTop;
    Object.assign(thumb.style, { left: `${x}px`, top: `${y}px`, width: `${on.offsetWidth}px`, height: `${on.offsetHeight}px`, opacity: '1' });
    if (anim && prev && (prev.x !== x || prev.y !== y)) animate(thumb, { x: [prev.x - x, 0], y: [prev.y - y, 0] }, SPRING.snappy);
    prev = { x, y };
  };

  const mo = new MutationObserver(() => place(true));
  mo.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  const ro = new ResizeObserver(() => place(false));
  ro.observe(container);
  place(false);
  return () => { mo.disconnect(); ro.disconnect(); thumb.remove(); container.classList.remove('has-thumb'); };
}
