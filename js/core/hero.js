// ============================================================
// hero.js —— 首屏：没有载入视频时占满工作区；点顶栏 logo 也能回到这里
//   显示规则：state.view === 'hero'（点了 logo），或者 view 为 'auto' 且还没有视频、也没有任务在跑。
//   拖入封面图、出错（错误提示在工作台里）、载入视频时 view 变成 'workspace'。
//   打开页面时如果会自动载入上次的视频（state.heroSuppressed），先不显示，避免首屏一闪而过。
//   右边手机框里循环播放一段演示：01 平台界面线稿 → 02 扫描线扫过、扫过的地方显示实际画面 → 03 被挡住的字幕闪烁、问题数跳到 1 → 打勾。
//   左边的演示进度（#heroReadout）跟着高亮当前阶段。
// ============================================================
import { state, subscribe, notify, currentPlatform } from './store.js';
import { $, esc } from './ui.js';
import { tr, getLang } from './i18n.js';
import { loadTestVideo } from './media.js';
import { animate, countUp, drawStroke, flyFrom, hasMotion, reducedMotion, SPRING, DUR } from './motion.js';
import * as heroCanvas from '../lib/hero-canvas.js';
import { mountHeroMore } from './hero-more.js';
import { FIX_DEFS } from '../modules/tech/fixes.js';

let shown = false;   // 首屏当前是否显示
let shows = 0;       // 本次页面加载以来首屏出现了几次（验证“自动载入不闪”用）
let loopToken = 0;   // 演示循环的编号：停止时加一，旧循环看到编号变了就退出
let flyNext = false; // 下一次离开首屏时播放“飞入工作台”（载入了新视频）；点“继续检查”只淡入

export const heroShowCount = () => shows;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 演示进度：stage 之前的阶段打勾，stage 这一段高亮（0 = 全部复位，4 = 全部完成） */
function setStage(stage) {
  document.querySelectorAll('#heroReadout li[data-stage]').forEach((li) => {
    const n = +li.dataset.stage;
    li.classList.toggle('done', n < stage);
    li.classList.toggle('on', n === stage);
  });
}

const CLIP_HIDDEN = 'inset(0 0 100% 0)', CLIP_SHOWN = 'inset(0 0 0% 0)';

/** 手机框演示循环。动画在窗口不可见时会暂停，循环跟着停在原地，回来后继续 */
async function demoLoop(token) {
  const phone = $('#heroPhone');
  const scan = phone.querySelector('.hp-scan'), real = phone.querySelector('.hp-real');
  const alertBox = phone.querySelector('.hp-alert'), check = phone.querySelector('.hp-check');
  const issues = $('#heroIssues');
  while (token === loopToken) {
    // 01 线稿：只看得到虚线框。先清掉上一轮留下的动画（结束后会停在最后一帧，盖住下面设的样式）
    [scan, real, alertBox, check].forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    [scan, alertBox, check].forEach((el) => { el.style.opacity = '0'; });
    real.style.opacity = '1';
    real.style.clipPath = CLIP_HIDDEN;
    issues.dataset.countFrom = '0';
    issues.textContent = '0';
    setStage(1);
    await wait(1300);
    if (token !== loopToken) return;
    // 02 扫描：扫描线往下走，实际画面跟着从上往下露出来
    setStage(2);
    const h = phone.querySelector('.hp-screen').clientHeight;
    scan.style.opacity = '1';
    animate(real, { clipPath: [CLIP_HIDDEN, CLIP_SHOWN] }, { duration: 1.8, ease: 'linear' });
    await animate(scan, { y: [0, h] }, { duration: 1.8, ease: 'linear' });
    if (token !== loopToken) return;
    real.style.clipPath = CLIP_SHOWN;
    animate(scan, { opacity: [1, 0] }, { duration: 0.2 });
    // 03 结果：被挡住的字幕闪烁，问题数跳到 1，打勾
    setStage(3);
    countUp(issues, 1, { duration: 0.5 });
    await animate(alertBox, { opacity: [0, 1, 0, 1, 0, 1] }, { duration: 1.1, ease: 'linear' });
    if (token !== loopToken) return;
    setStage(4);
    animate(check, { opacity: [0, 1], scale: [0.6, 1] }, SPRING.soft);
    drawStroke(check);
    await wait(2400);
    if (token !== loopToken) return;
    await Promise.all([real, alertBox, check].map((el) => animate(el, { opacity: [1, 0] }, { duration: 0.4 })));
    await wait(400);
  }
}

function startDemo() {
  const phone = $('#heroPhone');
  const still = !hasMotion() || reducedMotion();
  phone.classList.toggle('static', still);
  loopToken++;
  if (still) { // 不播动画：直接显示演示的最后一帧
    const real = phone.querySelector('.hp-real');
    real.style.clipPath = CLIP_SHOWN;
    real.style.opacity = '';
    phone.querySelectorAll('.hp-alert, .hp-check').forEach((el) => { el.style.opacity = ''; });
    phone.querySelector('.hp-scan').style.opacity = '0';
    $('#heroIssues').textContent = '1';
    setStage(4);
    return;
  }
  demoLoop(loopToken);
}
const stopDemo = () => { loopToken++; };

/**
 * 痛点一句拆成一个个小块逐个点亮：中文按字拆，英文按词拆（切换语言时重拆）。
 * 读屏软件读旁边 .sr-only 里的整句；拆开的部分标 translate="no"，免得被逐字翻译
 */
let ledeZh = '';
function splitLede() {
  const p = $('#heroLede');
  const sr = p.querySelector('.sr-only');
  ledeZh ||= sr.textContent;
  const text = tr(ledeZh);
  const parts = getLang() === 'en' ? text.split(/(\s+)/) : [...text];
  let wrap = p.querySelector('[aria-hidden]');
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.setAttribute('translate', 'no');
    p.appendChild(wrap);
  }
  wrap.innerHTML = parts.map((w, i) => (/^\s+$/.test(w) ? w : `<span style="--i:${i}">${esc(w)}</span>`)).join('');
}
/** 每次进入首屏重新点亮一遍 */
function lightLede() {
  const p = $('#heroLede');
  p.classList.remove('lit');
  void p.offsetWidth;
  p.classList.add('lit');
}

/** 能力卡片上的数字：修复项个数、配置里的平台数、当前平台的封面比例数 */
function statValues() {
  return {
    statFixes: FIX_DEFS.length,
    statPlatforms: Object.keys(state.config?.platforms || {}).length || 2,
    statRatios: currentPlatform()?.cover?.ratios?.length || 3,
  };
}
/** fromZero：刚进入首屏，从 0 滚上来；否则（配置载入、切换平台）只从旧值滚到新值 */
function renderStats(fromZero) {
  Object.entries(statValues()).forEach(([id, n]) => {
    const el = $(`#${id}`);
    if (fromZero) el.dataset.countFrom = '0';
    countUp(el, n);
  });
}

export function showHero() {
  if (shown) return;
  shown = true;
  shows++;
  $('#hero').hidden = false;
  $('#homeNav').classList.add('on');
  $('#homeNav').setAttribute('aria-current', 'page');
  document.body.classList.add('on-hero');
  const o = state.original;
  $('#heroContinue').hidden = !o;
  if (o) $('#heroContinueName').textContent = o.file.name;
  startDemo();
  lightLede();
  renderStats(true);
  heroCanvas.start($('#heroCanvas'));
}

export function hideHero() {
  if (!shown) return;
  shown = false;
  $('#hero').hidden = true;
  $('#homeNav').classList.remove('on');
  $('#homeNav').removeAttribute('aria-current');
  document.body.classList.remove('on-hero');
  stopDemo();
  heroCanvas.stop();
}

/**
 * 首屏 → 工作台：拖放区缩小飞到左栏（视频卡片或左栏拖放区），三张能力卡片收拢到左栏的步骤导航，右侧面板从下往上浮现。
 * from 是离开首屏前量好的位置；这时工作台已经显示，直接量目标位置。
 */
function flyIn(from) {
  const visible = (el) => el && !el.hidden && el.offsetParent;
  const target = [$('#mediaCard'), $('#drop')].find(visible);
  if (target) flyFrom(from.drop, target);
  const steps = [...document.querySelectorAll('#mainTabs button[data-tab]')];
  from.caps.forEach((r, i) => { if (steps[i]) flyFrom(r, steps[i]); });
  animate(document.querySelector('.right'), { opacity: [0, 1], y: [24, 0] }, { ...SPRING.soft, delay: 0.08 });
}

/** 按当前状态决定显示首屏还是工作台 */
export function syncHero() {
  const want = !state.heroSuppressed && (state.view === 'hero' || (state.view === 'auto' && !state.original && !state.busy));
  const leaving = shown && !want;
  const from = leaving && flyNext
    ? { drop: $('#heroDrop').getBoundingClientRect(), caps: [...document.querySelectorAll('.hero-cap')].map((c) => c.getBoundingClientRect()) }
    : null;
  if (want) { if (shown) renderStats(false); showHero(); } else hideHero();
  // 分析 / 处理中回到首屏：这时不能换视频，按钮禁用并说明
  $('#heroPick').disabled = $('#heroTest').disabled = state.busy;
  $('#heroDrop').setAttribute('aria-disabled', String(state.busy));
  $('#heroBusy').hidden = !(want && state.busy);
  if (state.busy && state.original) $('#heroBusyName').textContent = state.original.file.name;
  const ws = document.querySelector('.workspace');
  ws.hidden = want || (state.heroSuppressed && !state.original);
  if (!leaving) return;
  flyNext = false;
  if (from) flyIn(from);
  else animate(ws, { opacity: [0, 1] }, { duration: DUR.base });
}

export function mountHero() {
  splitLede();
  mountHeroMore();
  const input = $('#fileInput'), drop = $('#heroDrop');
  const toWorkspace = () => { state.view = 'workspace'; notify('update'); };
  drop.addEventListener('click', (e) => { if (!state.busy && !e.target.closest('#heroTest')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (!state.busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.click(); } });
  $('#heroTest').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.busy) return; // 正在处理别的视频：按钮本来就是禁用的，这里再挡一下
    state.view = 'workspace';
    flyNext = true;
    loadTestVideo();
  });
  $('#heroContinue').addEventListener('click', toWorkspace);
  const toHero = () => { state.view = 'hero'; notify('update'); scrollTo({ top: 0 }); };
  $('#homeBtn').addEventListener('click', toHero);
  $('#homeNav').addEventListener('click', toHero);
  subscribe((reason) => {
    if (reason === 'before-new-file') { state.view = 'workspace'; flyNext = true; } // 载入了新视频：飞入工作台
    if (reason === 'lang') { splitLede(); if (shown) lightLede(); }
    syncHero();
  });
  syncHero();
}
