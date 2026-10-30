// ============================================================
// prefs.js —— 顶栏的深浅色切换和中英文切换，记在本机浏览器（localStorage 的 theme / lang）
//   默认浅色、中文，不跟随系统。页面一打开，<head> 里的一小段脚本就先按记录设好 data-theme 和 lang，
//   避免先显示浅色 / 中文再跳过去；英文模式下在翻译完成前先把页面藏起来（html.i18n-pending）。
// ============================================================
import { notify } from './store.js';
import { $ } from './ui.js';
import { setLang, getLang } from './i18n.js';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } }; // 隐私模式等情况下读不到
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } };

const isDark = () => document.documentElement.dataset.theme === 'dark';

function applyTheme(dark) {
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  const b = $('#themeBtn');
  b.setAttribute('aria-pressed', String(dark));
  b.title = dark ? '切换到浅色模式' : '切换到深色模式';
  b.setAttribute('aria-label', b.title);
}

function renderLangSeg() {
  document.querySelectorAll('#langSeg button').forEach((b) => {
    const on = b.dataset.lang === getLang();
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function mountPrefs() {
  applyTheme(read('theme') === 'dark');
  try {
    setLang(read('lang') === 'en' ? 'en' : 'zh');
  } finally {
    document.documentElement.classList.remove('i18n-pending');
  }
  renderLangSeg();

  $('#themeBtn').addEventListener('click', () => {
    const dark = !isDark();
    applyTheme(dark);
    write('theme', dark ? 'dark' : 'light');
  });
  $('#langSeg').addEventListener('click', (e) => {
    const l = e.target.closest('button[data-lang]')?.dataset.lang;
    if (!l || l === getLang()) return;
    setLang(l);
    write('lang', l);
    renderLangSeg();
    notify('lang'); // 各模块重新渲染（代码里用 t() 生成的文字跟着换）
  });
}
