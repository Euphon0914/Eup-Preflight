// ============================================================
// box-editor.js —— 在一个容器上画框、拖动、拖角缩放（画面遮挡检查、封面适配的“手动框选文字”共用）
//
// 框的坐标是相对容器的百分比 { x, y, w, h }。这里只处理鼠标 / 触摸操作，框的显示由各模块自己渲染：
//   框元素带 data-mb="序号"；选中的框里放四个把手 <i class="hd" data-h="nw|ne|se|sw">；
//   删除按钮带 data-mb-del="序号"（点击由模块自己处理，这里会忽略它）。
// ============================================================

const MIN = 1.5; // 框最小 1.5%
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * @param {HTMLElement} el 容器
 * @param {object} o
 *   enabled()            当前是否处于框选模式
 *   get()                当前的框列表
 *   set(list, final)     拖动中（final = false）/ 松开时（final = true）的新列表
 *   select(i)            选中第 i 个（-1 表示不选）
 */
export function attachBoxEditor(el, o) {
  let drag = null;
  const point = (e) => {
    const b = el.getBoundingClientRect();
    return { x: clamp(((e.clientX - b.left) / b.width) * 100, 0, 100), y: clamp(((e.clientY - b.top) / b.height) * 100, 0, 100) };
  };

  el.addEventListener('pointerdown', (e) => {
    if (!o.enabled() || e.button !== 0 || e.target.closest('[data-mb-del]')) return;
    const p = point(e);
    const boxEl = e.target.closest('[data-mb]');
    const hd = e.target.closest('.hd');
    const list = o.get().map((b) => ({ ...b }));
    if (boxEl && el.contains(boxEl)) {
      const i = +boxEl.dataset.mb;
      o.select(i);
      drag = { i, op: hd ? hd.dataset.h : 'move', start: p, b0: { ...list[i] }, list, moved: false };
    } else {
      list.push({ x: p.x, y: p.y, w: MIN, h: MIN });
      drag = { i: list.length - 1, op: 'new', start: p, list, moved: false };
    }
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = point(e), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 0.5) return;
    drag.moved = true;
    const b0 = drag.b0;
    let r;
    if (drag.op === 'new') {
      r = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.max(Math.abs(dx), MIN), h: Math.max(Math.abs(dy), MIN) };
    } else if (drag.op === 'move') {
      r = { ...b0, x: clamp(b0.x + dx, 0, 100 - b0.w), y: clamp(b0.y + dy, 0, 100 - b0.h) };
    } else {
      const R = b0.x + b0.w, B = b0.y + b0.h;
      let { x, y, w, h } = b0;
      if (drag.op.includes('w')) { x = clamp(b0.x + dx, 0, R - MIN); w = R - x; }
      if (drag.op.includes('e')) w = clamp(b0.w + dx, MIN, 100 - b0.x);
      if (drag.op.includes('n')) { y = clamp(b0.y + dy, 0, B - MIN); h = B - y; }
      if (drag.op.includes('s')) h = clamp(b0.h + dy, MIN, 100 - b0.y);
      r = { ...b0, x, y, w, h };
    }
    drag.list[drag.i] = { ...drag.list[drag.i], ...r };
    if (drag.op === 'new' && drag.list.length > o.get().length) o.select(drag.i);
    o.set(drag.list, false);
  });

  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.op === 'new' && !d.moved) { o.select(-1); o.set(o.get(), true); return; } // 只是点了一下空白处：取消选中
    o.set(d.list, true);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** 渲染一个可编辑的框（模块里拼 HTML 用） */
export function boxHtml(b, i, { selected, label, cls = '' }) {
  const handles = selected ? ['nw', 'ne', 'se', 'sw'].map((h) => `<i class="hd" data-h="${h}"></i>`).join('') + `<b class="mb-del" data-mb-del="${i}" title="删除这个框">×</b>` : '';
  return `<div class="mb ${cls} ${selected ? 'sel' : ''}" data-mb="${i}" style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%"><span>${label}</span>${handles}</div>`;
}
