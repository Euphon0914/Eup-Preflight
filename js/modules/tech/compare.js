// ============================================================
// compare.js —— 技术体检 › 对比：处理前后的总分、文件大小与上传时间、截帧、音量、播放、逐项对比
// ============================================================
import { state, currentPlatform, currentRules, metricsOf } from '../../core/store.js';
import { $, esc, badge, fmtSec, fmtMB } from '../../core/ui.js';
import { evaluate, summarize } from '../../lib/rules-engine.js';

// ---------- 对比 ----------
// 状态好坏排序，用于判断“变好 / 变差”
const RANK = { fail: 0, warn: 1, pass: 2 };

export function renderCompare() {
  const o = state.original, f = state.fixed;
  const has = !!(o?.info && f?.info);
  $('#compareEmpty').hidden = has;
  $('#compareBody').hidden = !has;
  $('#countCompare').hidden = !has;
  if (!has) return;
  const pname = currentPlatform().name;
  const before = evaluate(currentRules(), metricsOf(o), { loudnessPending: o.loudPending });
  const after = evaluate(currentRules(), metricsOf(f), { loudnessPending: f.loudPending });
  const cb = summarize(before), ca = summarize(after);

  // 1) 总分卡片
  const verdict = { pass: '可以直接上传', warn: '有建议优化项', fail: '有硬性问题' };
  const card = (title, c, slot) => `<div class="score ${c.verdict}">
      <div class="score-title">${title}</div>
      <div class="score-verdict">${verdict[c.verdict]}</div>
      <div>${badge('fail')} ${c.fail} ${badge('warn')} ${c.warn} ${badge('pass')} ${c.pass}</div>
      <div class="hint" title="${esc(slot.file.name)}">${esc(slot.file.name)}</div>
    </div>`;
  const improved = before.filter((b, i) => RANK[after[i].status] > RANK[b.status]).length;
  const regressed = before.filter((b, i) => RANK[after[i].status] < RANK[b.status]).length;
  $('#compareCards').innerHTML = card('处理前', cb, o) + '<div class="score-arrow">→</div>' + card('处理后', ca, f) +
    `<div class="score-delta">按${pname}规则：<span class="up">${improved} 项变好</span>${regressed ? `，<span class="down">${regressed} 项变差</span>` : '，没有变差的项'}</div>`;

  renderSizeCompare();

  // 2) 画面对比
  const times = state.frameTimes || [];
  $('#frameCompare').innerHTML = !o.info.hasVideo ? '<p class="hint">没有视频轨。</p>' : !o.frames
    ? '<p class="hint">截帧中…</p>'
    : times.map((t, i) => `<div class="frame-pair">
        <div class="frame-time">${t} 秒</div>
        <div class="frame-imgs">${frameImg(o.frames[i], '处理前')}${frameImg(f.frames?.[i], '处理后')}</div>
      </div>`).join('');

  // 3) 响度刻度尺
  $('#loudViz').innerHTML = renderLoudBar(o, f);

  // 4) 播放器（只在 slot 变化时重建，避免打断播放）
  if (!o.url) o.url = URL.createObjectURL(o.file);
  const key = o.url + '|' + f.url;
  if ($('#videoCompare').dataset.key !== key) {
    $('#videoCompare').dataset.key = key;
    $('#videoCompare').innerHTML = `
      <figure><video id="vBefore" src="${o.url}" controls muted playsinline preload="metadata"></video>
        <div class="hint video-err" hidden>浏览器无法直接播放这个格式（如 MKV / HEVC），请看上面的截帧。</div><figcaption>处理前（已静音）</figcaption></figure>
      <figure><video id="vAfter" src="${f.url}" controls playsinline preload="metadata"></video><figcaption>处理后</figcaption></figure>`;
    $('#vBefore').addEventListener('error', (e) => { e.target.hidden = true; e.target.nextElementSibling.hidden = false; });
  }

  // 5) 逐项对比（默认只看有变化的项）
  const onlyChanged = $('#onlyChanged').checked;
  const rows = before.map((b, i) => {
    const a = after[i];
    return { b, a, better: RANK[a.status] > RANK[b.status], worse: RANK[a.status] < RANK[b.status], changed: a.actual !== b.actual || a.status !== b.status };
  }).filter((r) => !onlyChanged || r.changed);
  $('#compareTable').innerHTML = rows.length
    ? rows.map(({ b, a, better, worse }) => `<div class="diff ${better ? 'better' : worse ? 'worse' : ''}">
        <div class="diff-name">${esc(b.rule.item)}</div>
        <div class="diff-vals">${badge(b.status)}<span class="hint">${esc(b.actual)}</span><span class="arrow">→</span>${badge(a.status)}<span class="hint">${esc(a.actual)}</span></div>
        <div class="diff-msg">${esc(a.message)}</div>
      </div>`).join('')
    : '<div class="diff-empty">没有变化的检查项。</div>';
}

/** 读取上行带宽（Mbps），无效时按 30 计算 */
function getBandwidth() {
  const v = parseFloat($('#bwInput').value);
  return v > 0 ? v : 30;
}

/** 文件大小对比 + 按带宽估算上传时间 */
export function renderSizeCompare() {
  const o = state.original, f = state.fixed;
  if (!o?.file || !f?.file) return;
  const a = o.file.size, b = f.file.size;
  const ratio = b / a;
  const change = ratio <= 1
    ? `缩小 ${Math.round((1 - ratio) * 100)}%${ratio < 0.5 ? `，约为原来的 1/${Math.round(1 / ratio)}` : ''}`
    : `增大 ${Math.round((ratio - 1) * 100)}%`;
  $('#sizeCompare').innerHTML = `文件大小：<b>${fmtMB(a)}</b> → <b>${fmtMB(b)}</b>（<span class="${ratio <= 1 ? 'up' : 'down'}">${change}</span>）`;
  const mbps = getBandwidth();
  const t = (bytes) => (bytes * 8) / (mbps * 1e6);
  // 算总账：本次处理实测耗时 + 上传处理后文件，对比直接上传原片，判断“先瘦身再上传”值不值
  let verdict = '';
  // 只有以“变小”为目的（瘦身 / 压缩）时才算总账，其他修复不是为了省上传时间
  if (f.processMs && (f.fixes?.slim || f.fixes?.compress)) {
    const viaSlim = f.processMs / 1000 + t(b), direct = t(a);
    verdict = `<br>算总账：处理 ${fmtSec(f.processMs / 1000)} + 上传 ${fmtSec(t(b))} = <b>${fmtSec(viaSlim)}</b>，直接上传原片 <b>${fmtSec(direct)}</b> → ` +
      (viaSlim < direct ? `<span class="up">先处理再上传快 ${fmtSec(direct - viaSlim)}</span>` : `<span class="down">按这个带宽，直接上传原片更快</span>`);
  }
  $('#uploadEst').innerHTML = `<b>${fmtSec(t(a))}</b> → <b>${fmtSec(t(b))}</b>${verdict}`;
}

const frameImg = (url, cap) => `<figure><img src="${url || ''}" alt="${cap}" ${url ? '' : 'hidden'}>${url ? '' : '<div class="hint">截帧失败</div>'}<figcaption>${cap}</figcaption></figure>`;

/** 响度刻度尺：-30 ~ 0 LUFS，绿色区间为平台建议范围，两个标记分别是处理前 / 后 */
function renderLoudBar(o, f) {
  if (o.loud?.audioSilent && f.loud?.audioSilent) return '<p class="hint">音轨全程静音，没有响度可比较。</p>';
  if (!o.loud && !f.loud) return '<p class="hint">没有音轨或未完成声音分析。</p>';
  const rule = currentRules().find((r) => r.check.metric === 'loudnessLUFS');
  const [lo, hi] = rule?.check.op === 'between' ? rule.check.value : [-16, -12];
  const MIN = -30, MAX = 0;
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - MIN) / (MAX - MIN)) * 100))}%`;
  const marker = (slot, cls, name) => slot.loud && !slot.loud.audioSilent
    ? `<div class="lmark ${cls}" style="left:${pos(slot.loud.loudnessLUFS)}"><span>${name} ${slot.loud.loudnessLUFS}</span></div>` : '';
  const ticks = [-30, -24, -18, -14, -12, -6, 0].map((v) => `<span class="ltick" style="left:${pos(v)}">${v}</span>`).join('');
  return `<div class="lbar">
      <div class="lband" style="left:${pos(lo)};width:calc(${pos(hi)} - ${pos(lo)})"></div>
      ${marker(o, 'before', '处理前')}${marker(f, 'after', '处理后')}
    </div>
    <div class="lticks">${ticks}</div>
    <p class="hint">整体响度（LUFS，越靠右越响）；绿色是${currentPlatform().name}建议范围 ${lo} ～ ${hi}。
      真峰值：${o.loud?.truePeakDBTP ?? '—'} → ${f.loud?.truePeakDBTP ?? '—'} dBTP。</p>`;
}

