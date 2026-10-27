// ============================================================
// compat.js —— 浏览器兼容提示
// 工具依赖几项较新的浏览器能力：WebCodecs（硬件编解码，修复和画面遮挡检查用）、
// 浏览器本地文件存储 OPFS（保存处理结果和最近导入的视频）。Chrome / Edge 都支持，也是实测过的浏览器。
// 缺少这些能力，或者是没有完整测试过的浏览器（Safari、Firefox）时，在页面顶部提示改用 Chrome / Edge。
// 可以关掉提示（记在本机浏览器里）。
// ============================================================
import { $, esc } from './ui.js';

const DISMISS_KEY = 'compatDismissed';

/** 检查浏览器，返回 { name, missing:[缺少的能力], tested:是否实测过 } */
export function checkBrowser() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '当前浏览器';
  const missing = [];
  if (!('VideoEncoder' in self) || !('VideoDecoder' in self)) missing.push('视频硬件编解码（WebCodecs）：修复会退回很慢的方式，画面遮挡检查也会变慢');
  const opfsWrite = !!navigator.storage?.getDirectory && typeof self.FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
  if (!opfsWrite) missing.push('浏览器本地文件存储：处理结果、最近导入的视频无法保存，刷新后需要重新导入');
  return { name, missing, tested: name === 'Chrome' || name === 'Edge' };
}

/** 需要时在顶栏下面显示提示 */
export function mountCompatNotice() {
  const r = checkBrowser();
  if (r.tested && !r.missing.length) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(DISMISS_KEY) === r.name; } catch { /* 隐私模式等情况下读不到，照常显示 */ }
  if (dismissed) return;
  const bar = $('#compatBar');
  bar.innerHTML = `<div class="compat-body">
      <b>建议用 Chrome 或 Edge 打开</b>
      <span>${esc(r.name)} ${r.missing.length ? '缺少本工具需要的部分能力：' : '上还没有完整测试过，部分功能可能不正常。'}</span>
      ${r.missing.length ? `<ul>${r.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    </div>
    <button class="btn ghost sm" id="compatClose">知道了</button>`;
  bar.hidden = false;
  $('#compatClose').addEventListener('click', () => {
    bar.hidden = true;
    try { localStorage.setItem(DISMISS_KEY, r.name); } catch { /* 忽略 */ }
  });
}
