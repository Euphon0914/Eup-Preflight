// ============================================================
// compat.js —— 浏览器兼容提示
// 工具依赖几项较新的浏览器能力：WebCodecs（硬件编解码，修复和画面遮挡检查用）、
// 浏览器本地文件存储 OPFS（保存处理结果和最近导入的视频）。Chrome / Edge 都支持，也是实测过的浏览器。
// 缺少这些能力，或者是没有完整测试过的浏览器（Safari、Firefox）时，在页面顶部提示改用 Chrome / Edge。
// 手机和 App 内置浏览器（微信、QQ 等）单独提示：安卓手机自带浏览器实测「一键修复」后画面颜色明显改变（发灰、偏色），
// 手机内存小、处理大视频也容易中途失败。可以关掉提示（记在本机浏览器里）。
// ============================================================
import { $, esc } from './ui.js';

const DISMISS_KEY = 'compatDismissed';

// App 内置浏览器：UA 里的标记 → 显示名
const IN_APP = [
  [/MicroMessenger/i, '微信内置浏览器'], [/\bQQ\//i, 'QQ 内置浏览器'], [/DingTalk/i, '钉钉内置浏览器'],
  [/Lark|Feishu/i, '飞书内置浏览器'], [/Weibo/i, '微博内置浏览器'], [/aweme|BytedanceWebview|NewsArticle/i, '抖音 / 今日头条内置浏览器'],
  [/UCBrowser/i, 'UC 浏览器'], [/Quark/i, '夸克浏览器'],
];

/** 检查浏览器，返回 { name, missing:[缺少的能力], tested:是否实测过, inApp:App 内置浏览器, mobile:手机或平板 } */
export function checkBrowser() {
  const ua = navigator.userAgent;
  const inApp = IN_APP.find(([re]) => re.test(ua))?.[1] || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua) || navigator.userAgentData?.mobile === true;
  const name = inApp || (/Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '当前浏览器');
  const missing = [];
  if (!('VideoEncoder' in self) || !('VideoDecoder' in self)) missing.push('视频硬件编解码（WebCodecs）：修复会退回很慢的方式，画面遮挡检查也会变慢');
  const opfsWrite = !!navigator.storage?.getDirectory && typeof self.FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
  if (!opfsWrite) missing.push('浏览器本地文件存储：处理结果、最近导入的视频无法保存，刷新后需要重新导入');
  return { name, missing, inApp, mobile, tested: !inApp && !mobile && (name === 'Chrome' || name === 'Edge') };
}

/** 提示的标题和说明 */
function noticeText(r) {
  if (r.mobile) {
    return ['修复请用电脑', '手机浏览器实测「一键修复」后画面颜色可能明显改变（发灰、偏色），处理大视频也容易中途失败。' +
      '手机上的体检结果可以参考，修复视频请用电脑上的 Chrome 或 Edge。'];
  }
  if (r.inApp) return ['建议用 Chrome 或 Edge 打开', `${r.name}上没有测试过，部分功能可能不正常，处理后的视频请先检查画面颜色。`];
  return ['建议用 Chrome 或 Edge 打开', `${r.name} ${r.missing.length ? '缺少本工具需要的部分能力：' : '上还没有完整测试过，部分功能可能不正常。'}`];
}

/** 需要时在顶栏下面显示提示 */
export function mountCompatNotice() {
  const r = checkBrowser();
  if (r.tested && !r.missing.length) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === r.name; } catch { /* 隐私模式等情况下读不到，照常显示 */ }
  if (dismissed) return;
  const [title, text] = noticeText(r);
  const bar = $('#compatBar');
  bar.innerHTML = `<div class="compat-body">
      <b>${esc(title)}</b>
      <span>${esc(text)}</span>
      ${r.missing.length ? `<ul>${r.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    </div>
    <button class="btn ghost sm" id="compatClose">知道了</button>`;
  bar.hidden = false;
  $('#compatClose').addEventListener('click', () => {
    bar.hidden = true;
    try { localStorage.setItem(DISMISS_KEY, r.name); } catch { /* 忽略 */ }
  });
}
