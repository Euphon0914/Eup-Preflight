// ============================================================
// main.js —— Eup Preflight 的入口：读配置 → 挂载外壳和各模块
//
// 结构：
//   core/     共享部分：状态（store）、配置、视频载入与分析（media）、界面工具（ui）、外壳（shell）
//   lib/      底层能力：读参数、规则判定、ffmpeg、WebCodecs、处理历史
//   modules/  四个标签页：技术体检 tech、画面遮挡检查 occlusion、封面适配 cover、总报告 summary
// 视频只拖入一次，文件和分析结果都在 store 里，各模块共用。
// ============================================================
import { state, notify } from './core/store.js';
import { loadConfig } from './core/config.js';
import { mountShell } from './core/shell.js';
import { mountHero } from './core/hero.js';
import { mountCompatNotice } from './core/compat.js';
import { mountGlassLight } from './core/glass-light.js';
import { loadVideo } from './core/media.js';
import { showError } from './core/ui.js';
import { canUseMT } from './lib/ffmpeg-tools.js';
import { listRecent, openRecent, removeRecent, cleanupRecent, autoLoadEnabled } from './lib/recent-videos.js';
import * as tech from './modules/tech/index.js';
import * as occlusion from './modules/occlusion/index.js';
import * as cover from './modules/cover/index.js';
import * as summary from './modules/summary/index.js';

(async function init() {
  // “高级”里的多线程选项：浏览器不支持时禁用
  if (!canUseMT()) {
    const opt = document.querySelector('#modeSel option[value="mt"]');
    opt.disabled = true;
    opt.textContent = '多线程（不可用：需 COOP/COEP 响应头）';
  }

  mountShell();
  mountHero();
  mountCompatNotice(); // 不支持或没测试过的浏览器：顶部提示改用 Chrome / Edge
  mountGlassLight();   // 玻璃上的鼠标反光
  tech.mount();
  occlusion.mount();
  cover.mount();
  summary.mount([tech, occlusion, cover]); // 总报告汇总这三个模块

  try {
    state.config = await loadConfig();
    notify('config');
  } catch (e) {
    showError(e.message);
  }

  // 自动载入上一次的视频（存在本机浏览器里，见 lib/recent-videos.js）
  await cleanupRecent().catch((e) => console.warn('整理最近导入的视频失败：', e));
  notify('recent');
  const last = listRecent()[0];
  if (last && autoLoadEnabled() && !state.original && state.config) {
    try {
      const loading = loadVideo(await openRecent(last.id), { remember: false, restored: true });
      state.heroSuppressed = false; // 视频已经开始载入（state.original 有了），之后点 logo 可以回首屏
      await loading;
    } catch (e) {
      console.warn('自动载入上次的视频失败：', e);
      await removeRecent(last.id);
      notify('recent');
    }
  }
  // 自动载入的事处理完了（载入了、失败了或者不需要）：没有视频时可以显示首屏了
  state.heroSuppressed = false;
  notify('update');

  // 方便调试：在控制台可通过 window.__app 访问
  window.__app = { state, notify, loadVideo };
})();
