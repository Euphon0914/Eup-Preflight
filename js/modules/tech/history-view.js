// ============================================================
// history-view.js —— 技术体检 › 历史：
//   最近导入的视频（载入 / 删除，见 lib/recent-videos.js）
//   处理结果（保存 / 列出 / 播放 / 下载 / 载入体检 / 删除）
// 都存在本机浏览器
// ============================================================
import { state, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, badge, fmtMB, fmtSec, fmtTime, stampName, showError, recentThumbHtml, fillRecentThumbs } from '../../core/ui.js';
import { evaluate, summarize } from '../../lib/rules-engine.js';
import { saveOutput, listOutputs, deleteOutput, storageUsage } from '../../lib/history.js';
import { readOPFSFile, removeOPFSFile, cleanOPFSDir } from '../../lib/webcodecs.js';
import { listRecent, openRecent, removeRecent, autoLoadEnabled, setAutoLoad } from '../../lib/recent-videos.js';
import { loadVideo } from '../../core/media.js';
import { t } from '../../core/i18n.js';

// 历史表里显示的修复项简称
const FIX_SHORT = {
  slim: '瘦身', to_mp4: '转MP4', trim: '截断', compress: '压缩', to_cfr: '固定帧率', fps_range: '调整帧率',
  hdr_to_sdr: 'HDR→SDR', upscale: '放大', bitrate_floor: '码率下限', loudnorm: '统一音量', resample: '统一采样率',
  downmix: '下混', add_audio: '静音音轨', vertical: '横屏转竖屏',
};
/** 把当前处理结果存进历史（IndexedDB）；失败不影响本次结果，只提示 */
export async function saveHistory() {
  const o = state.original, f = state.fixed;
  if (!o?.info || !f?.info) return;
  const count = (slot) => { const c = summarize(evaluate(currentRules(), metricsOf(slot), {})); return { pass: c.pass, warn: c.warn, fail: c.fail }; };
  try {
    f.historyId = await saveOutput({
      // 结果已经写在本地磁盘（OPFS）上时只记位置，不再复制一份；否则把文件本身存进 IndexedDB
      ...(f.out?.onDisk ? { opfs: { dir: f.out.dir, name: f.out.name } } : { file: f.file }),
      name: f.file.name, sizeBytes: f.file.size,
      srcName: o.file.name, srcSizeBytes: o.file.size,
      platform: state.platform, platformName: currentPlatform().name, kind: f.kind,
      fixes: Object.keys(f.fixes).filter((k) => f.fixes[k]),
      plan: f.plan, processMs: f.processMs,
      before: count(o), after: count(f),
      out: { w: f.info.width, h: f.info.height, fps: f.info.frameRate, kbps: f.info.videoBitrateKbps, hdr: f.info.isHDR, lufs: f.loud?.loudnessLUFS ?? null },
    });
  } catch (e) {
    console.error(e);
    showError(`保存到处理历史失败（可能是浏览器存储空间不足）：${e.message || e}。本次结果仍可在上方直接下载。`);
  }
  await renderHistory();
}

const sizeText = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : fmtMB(b));

/** 最近导入的视频 */
export function renderRecent() {
  const list = listRecent();
  $('#autoLoadLast').checked = autoLoadEnabled();
  const cur = state.original?.file;
  const isCur = (r) => cur && cur.name === r.name && cur.size === r.size && cur.lastModified === r.lastModified;
  $('#recentList').innerHTML = list.length
    ? list.map((r) => `<div class="hist-item recent-item ${isCur(r) ? 'current' : ''}">
        ${recentThumbHtml(r)}
        <div class="r-main"><span class="r-name" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="hint">${sizeText(r.size)} · 上次使用 ${fmtTime(r.usedAt)}${r.opfs.dir === 'outputs' ? ' · 处理结果' : ''}</span></div>
        ${isCur(r) ? '<span class="tag">当前</span>' : ''}
        <div class="actions"><button class="btn sm" data-ract="load" data-id="${r.id}" ${isCur(r) || state.busy ? 'disabled' : ''}>载入</button><button class="btn ghost sm" data-ract="delete" data-id="${r.id}">删除</button></div>
      </div>`).join('')
    : '<p class="hint">还没有。导入的视频会自动出现在这里（复制一份到本机浏览器存储，不会上传）。</p>';
  fillRecentThumbs($('#recentList'));
}

/** 最近导入的视频：载入 / 删除 */
export async function onRecentAction(e) {
  const btn = e.target.closest('button[data-ract]');
  if (!btn) return;
  const id = +btn.dataset.id;
  if (btn.dataset.ract === 'load') {
    try {
      await loadVideo(await openRecent(id), { remember: false });
    } catch (err) {
      showError(`找不到这个视频文件（可能已被浏览器清理）：${err.message || err}`);
      await removeRecent(id);
    }
  } else if (btn.dataset.ract === 'delete') {
    const r = listRecent().find((x) => x.id === id);
    if (!r || !confirm(t('从“最近导入的视频”里删除？\n{name}\n只删除浏览器里保存的副本，不影响你电脑上的原文件。', { name: r.name }))) return;
    await removeRecent(id);
  }
  renderRecent();
  renderHistory();
}

export function onAutoLoadChange(e) {
  setAutoLoad(e.target.checked);
}

let historyPlayerUrl = null;
export async function renderHistory() {
  let list = [];
  try {
    list = await listOutputs();
  } catch (e) {
    $('#historyList').innerHTML = `<p class="hint">无法读取处理历史：${esc(e.message || e)}（隐私模式下可能不可用）</p>`;
    return;
  }
  const u = await storageUsage();
  $('#storageInfo').textContent = u ? ` 当前占用约 ${sizeText(u.usage)}（浏览器允许约 ${sizeText(u.quota)}）。` : '';
  $('#clearHistory').disabled = !list.length;
  $('#countHistory').textContent = list.length || '';
  if (!list.length) {
    $('#historyList').innerHTML = '<p class="hint">还没有处理结果。在「体检」里点「一键修复」处理后，会自动保存在这里。</p>';
    return;
  }
  const cnt = (c) => `${badge('fail')} ${c.fail} ${badge('warn')} ${c.warn} ${badge('pass')} ${c.pass}`;
  $('#historyList').innerHTML = list.map((r) => {
    const ratio = r.srcSizeBytes ? Math.round((1 - r.sizeBytes / r.srcSizeBytes) * 100) : null;
    const out = r.out || {};
    const current = r.id === state.fixed?.historyId;
    return `<div class="hist-item ${current ? 'current' : ''}">
      <div class="hist-head"><b>${fmtTime(r.createdAt)}</b><span>${r.kind === 'vertical' ? '横屏转竖屏' : '一键修复'} · ${esc(r.platformName)}</span>${current ? '<span class="tag">当前</span>' : ''}</div>
      <div>${esc(r.srcName)}（${fmtMB(r.srcSizeBytes)}）→ <b>${out.w}×${out.h} · ${out.fps ?? '?'} fps${out.hdr ? ' · HDR' : ''} · ${fmtMB(r.sizeBytes)}</b>${ratio !== null ? `（${ratio >= 0 ? '缩小' : '增大'} ${Math.abs(ratio)}%）` : ''}${r.processMs ? ` · 耗时 ${fmtSec(r.processMs / 1000)}` : ''}</div>
      <div class="hint">处理项：${esc(r.fixes.map((k) => FIX_SHORT[k] || k).join('、'))}</div>
      <div>体检：${cnt(r.before)} <span class="arrow">→</span> ${cnt(r.after)}</div>
      <div class="actions"><button class="btn sm" data-act="play" data-id="${r.id}">播放</button><button class="btn sm" data-act="load" data-id="${r.id}" ${state.busy ? 'disabled' : ''} title="把这个处理结果当作要检查的视频载入">载入体检</button><button class="btn sm" data-act="download" data-id="${r.id}">下载</button><button class="btn ghost sm" data-act="delete" data-id="${r.id}">删除</button></div>
    </div>`;
  }).join('');
}

/** 取出历史记录对应的视频文件（磁盘上的 OPFS 文件，或旧版存在 IndexedDB 里的文件） */
const historyFile = async (rec) => rec.file || readOPFSFile(rec.opfs.dir, rec.opfs.name, rec.name);

/** 启动时清理：删掉中间文件，以及磁盘上没有被处理历史引用的结果文件（例如上次处理中途关掉页面留下的） */
export async function cleanupStorage() {
  await cleanOPFSDir('tmp');
  try {
    const keep = new Set((await listOutputs()).filter((r) => r.opfs).map((r) => r.opfs.name));
    await cleanOPFSDir('outputs', keep);
  } catch (e) {
    console.warn('清理本地存储失败：', e);
  }
}

/** 处理结果里的 播放 / 载入体检 / 下载 / 删除 按钮 */
export async function onHistoryAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.dataset.id;
  const rec = (await listOutputs()).find((r) => r.id === id);
  if (!rec) return renderHistory();
  let file;
  try {
    file = await historyFile(rec);
  } catch (err) {
    if (btn.dataset.act !== 'delete') return showError(`找不到这条记录的视频文件（可能已被浏览器清理）：${err.message || err}`);
  }
  if (btn.dataset.act === 'download') {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = stampName(rec.name, rec.createdAt);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else if (btn.dataset.act === 'load') {
    // 处理结果已经在本机存储里：只记位置，不再复制一份
    await loadVideo(file, rec.opfs ? { ref: rec.opfs } : {});
  } else if (btn.dataset.act === 'play') {
    if (historyPlayerUrl) URL.revokeObjectURL(historyPlayerUrl);
    historyPlayerUrl = URL.createObjectURL(file);
    $('#historyPlayer').innerHTML = `<p class="hint">正在播放：${esc(rec.name)}（${fmtTime(rec.createdAt)}）</p><video src="${historyPlayerUrl}" controls autoplay playsinline></video>`;
  } else if (btn.dataset.act === 'delete') {
    if (!confirm(t('删除这条记录？\n{name}（{time}）\n删除后无法恢复。', { name: rec.name, time: fmtTime(rec.createdAt) }))) return;
    await deleteOutput(id);
    if (state.fixed?.historyId === id) {
      // 正在对比的就是这条：先留着磁盘文件（页面还在用），下次重新处理时再删
      state.fixed.historyId = null;
    } else if (rec.opfs && rec.opfs.name === state.original?.ref?.name) {
      // 正在检查的视频就是这个处理结果：页面还在用，先留着文件，下次打开页面时自动清理
    } else if (rec.opfs) {
      await removeOPFSFile(rec.opfs.dir, rec.opfs.name);
    }
    $('#historyPlayer').innerHTML = '';
    await renderHistory();
  }
}

