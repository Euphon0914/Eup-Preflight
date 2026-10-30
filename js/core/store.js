// ============================================================
// store.js —— 全站共享状态 + 事件通知
// 视频只拖入一次：文件、读到的参数、响度结果都放在这里，所有模块共用，不重复加载。
// 任何模块改了状态后调用 notify(原因)，订阅者（左栏、各模块、总报告）各自重新渲染。
// ============================================================

/**
 * slot（一个视频）的结构：
 *   { file, url, info, loud, loudPending, loudError, frames,         // 原视频 / 处理后都有
 *     plan, args, kind, fixes, processMs, out, historyId }          // 只有处理后的视频有（技术体检 › 一键修复）
 */
export const state = {
  config: null,          // config/platforms.json 的内容
  platform: 'douyin',    // 当前目标平台（顶栏切换）
  original: null,        // 原视频 slot
  fixed: null,           // 处理后的视频 slot（技术体检 › 一键修复的结果）
  busy: false,           // 是否有任务在跑（按钮会禁用）
  canceled: false,       // 用户点了取消（取消时不自动退回 ffmpeg）
  conversion: null,      // 正在执行的 WebCodecs 转码（取消用）
  timings: [],           // 每一步耗时（“高级”里显示）
  tab: 'tech',           // 一级标签：tech / occlusion / cover / summary
  techTab: 'report',     // 技术体检里的二级标签：report / fix / compare / history
  previewSrc: 'original',// 左栏预览：original / fixed
  frameTimes: null,      // 对比截帧的时间点
  coverImage: null,      // 拖进页面的图片，交给封面适配（'cover-image' 通知）
  navArg: null,          // 跳转附带的参数，例如 goto('occlusion:12') 里的 '12'（画面遮挡检查跳到第 12 秒）
  view: 'auto',          // 'auto' 没有视频时显示首屏 / 'hero' 点了顶栏 logo / 'workspace' 工作台（拖入了封面图、出错要显示时也切到这里，见 core/hero.js）
  heroSuppressed: true,  // 打开页面时先不显示首屏，等确定不会自动载入上次的视频再说（避免首屏一闪而过）
};

// ---------- 事件通知 ----------
const listeners = new Set();

/** 订阅状态变化；回调参数为变化原因（字符串），返回取消订阅函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 通知所有订阅者。常用原因：
 *   'config' 配置读完   'platform' 切换平台   'before-new-file' 换视频前（模块清理旧结果）
 *   'analyzed' 原视频分析完   'fixed' 有了处理结果   'busy' 忙/闲切换   'nav' 切换标签   'update' 其他刷新
 */
export function notify(reason = 'update') {
  for (const fn of listeners) {
    try { fn(reason); } catch (e) { console.error('渲染出错：', reason, e); }
  }
}

// ---------- 常用的派生数据 ----------
/** 当前平台的配置 { name, spec, overlay } */
export const currentPlatform = () => state.config?.platforms?.[state.platform];
/** 当前平台的技术规格规则 */
export const currentRules = () => currentPlatform()?.spec?.rules || [];
/** 合并参数和响度结果，作为规则引擎的输入 */
export const metricsOf = (slot) => ({ ...slot.info, ...(slot.loud || {}) });

/**
 * 跳转到某个标签。target 写法：'tech'、'summary'，或带二级标签的 'tech:fix'，或带参数的 'occlusion:12'（跳到第 12 秒）
 * （各模块里“可修复”“查看对比”“去处理”等按钮都用 data-goto 调到这里）
 */
export function goto(target) {
  const [tab, sub] = String(target).split(':');
  state.tab = tab;
  if (tab === 'tech' && sub) state.techTab = sub;
  state.navArg = tab !== 'tech' && sub !== undefined ? sub : null;
  notify('nav');
}

/** 导入视频后是否自动在后台检查画面遮挡、选封面帧（“高级”里可以关掉；记在本机浏览器） */
export function autoChecksEnabled() {
  try { return localStorage.getItem('autoChecks') !== '0'; } catch { return true; }
}
export function setAutoChecks(on) {
  try { localStorage.setItem('autoChecks', on ? '1' : '0'); } catch { /* 隐私模式等情况下存不了 */ }
}
