// ============================================================
// hero.js —— 首屏：没有载入视频时占满工作区；点顶栏 logo 也能回到这里
//   显示规则：state.view === 'hero'（点了 logo），或者还没有视频、也没有任务在跑。
//   打开页面时如果会自动载入上次的视频（state.heroSuppressed），先不显示，避免首屏一闪而过。
//   右边手机框里循环播放一段演示：扫描 → 界面区域浮现 → 被挡住的字幕闪烁 → 打勾。
// ============================================================
import { state, subscribe, notify } from './store.js';
import { $ } from './ui.js';
import { loadTestVideo } from './media.js';
import { animate, stagger, drawStroke, hasMotion, reducedMotion, SPRING } from './motion.js';

let shown = false;   // 首屏当前是否显示
let shows = 0;       // 本次页面加载以来首屏出现了几次（验证“自动载入不闪”用）
let loopToken = 0;   // 演示循环的编号：停止时加一，旧循环看到编号变了就退出

export const heroShowCount = () => shows;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 手机框演示循环。动画在窗口不可见时会暂停，循环跟着停在原地，回来后继续 */
async function demoLoop(token) {
  const phone = $('#heroPhone');
  const scan = phone.querySelector('.hp-scan'), zones = [...phone.querySelectorAll('.hp-zone')];
  const alertBox = phone.querySelector('.hp-alert'), check = phone.querySelector('.hp-check');
  const parts = [scan, ...zones, alertBox, check];
  while (token === loopToken) {
    parts.forEach((el) => { el.style.opacity = '0'; });
    const h = phone.querySelector('.hp-screen').clientHeight;
    scan.style.opacity = '1';
    await animate(scan, { y: [0, h] }, { duration: 1.6, ease: 'linear' });
    if (token !== loopToken) return;
    animate(scan, { opacity: [1, 0] }, { duration: 0.2 });
    stagger(zones, { gap: 0.25, y: 6 });
    await wait(700);
    if (token !== loopToken) return;
    await animate(alertBox, { opacity: [0, 1, 0, 1, 0, 1] }, { duration: 1.1, ease: 'linear' });
    if (token !== loopToken) return;
    animate(check, { opacity: [0, 1], scale: [0.6, 1] }, SPRING.soft);
    drawStroke(check);
    await wait(2200);
    if (token !== loopToken) return;
    await Promise.all(parts.slice(1).map((el) => animate(el, { opacity: [1, 0] }, { duration: 0.4 })));
    await wait(600);
  }
}

function startDemo() {
  const phone = $('#heroPhone');
  const still = !hasMotion() || reducedMotion();
  phone.classList.toggle('static', still);
  loopToken++;
  if (still) { // 不播动画：直接显示演示的最后一帧
    phone.querySelectorAll('.hp-zone, .hp-alert, .hp-check').forEach((el) => { el.style.opacity = ''; });
    phone.querySelector('.hp-scan').style.opacity = '0';
    return;
  }
  demoLoop(loopToken);
}
const stopDemo = () => { loopToken++; };

export function showHero() {
  if (shown) return;
  shown = true;
  shows++;
  $('#hero').hidden = false;
  document.body.classList.add('on-hero');
  const o = state.original;
  $('#heroContinue').hidden = !o;
  if (o) $('#heroContinueName').textContent = o.file.name;
  startDemo();
}

export function hideHero() {
  if (!shown) return;
  shown = false;
  $('#hero').hidden = true;
  document.body.classList.remove('on-hero');
  stopDemo();
}

/** 按当前状态决定显示首屏还是工作台 */
export function syncHero() {
  const want = !state.heroSuppressed && (state.view === 'hero' || (!state.original && !state.busy));
  if (want) showHero(); else hideHero();
  document.querySelector('.workspace').hidden = want || (state.heroSuppressed && !state.original);
}

export function mountHero() {
  const input = $('#fileInput'), drop = $('#heroDrop');
  const toWorkspace = () => { state.view = 'workspace'; notify('update'); };
  drop.addEventListener('click', (e) => { if (!e.target.closest('#heroTest')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  $('#heroTest').addEventListener('click', (e) => { e.stopPropagation(); state.view = 'workspace'; loadTestVideo(); });
  $('#heroContinue').addEventListener('click', toWorkspace);
  $('#homeBtn').addEventListener('click', () => { state.view = 'hero'; notify('update'); });
  subscribe((reason) => {
    if (reason === 'before-new-file') state.view = 'workspace'; // 载入了新视频：回到工作台
    syncHero();
  });
  syncHero();
}
