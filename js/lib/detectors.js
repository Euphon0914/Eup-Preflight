// ============================================================
// detectors.js —— 文字识别（Tesseract.js），画面遮挡检查和封面适配共用
// 库、wasm、语言数据都在 vendor/ 里，本地加载，不联网；用到时才加载。
//   Tesseract.js 7.0.0 + tesseract.js-core 7.0.0（只用 LSTM 引擎），语言 chi_sim + eng（4.0.0_best_int）
// 返回的框都是像素坐标 { x, y, w, h }（相对于传入的画布）。
// （不做人脸检测：人脸基本都在画面中间，一眼能看出来；封面的主体由用户自己框）
// ============================================================

const VENDOR = new URL('../../vendor/', import.meta.url).href;

// 文字识别的过滤条件：Tesseract 会把天花板、衣服纹理等认成乱码（实测多为“5 0 一”“| /”这类短碎片，置信度 20~75），
// 真实字幕的置信度：英文 90 以上，中文 70 左右（Tesseract 对中文普遍打分偏低）。所以中文、英文分开设门槛
const MIN_TEXT_H = 0.012;          // 行高至少为画面高度的 1.2%
const HAN = /\p{Script=Han}/gu;
const ALNUM = /[A-Za-z0-9]/g;
/** 判断一行识别结果像不像真的文字 */
function looksLikeText(text, conf) {
  const han = text.match(HAN) || [], alnum = text.match(ALNUM) || [];
  const nonSpace = text.replace(/\s/g, '').length;
  if (!nonSpace || (han.length + alnum.length) / nonSpace < 0.6) return false; // 大部分是符号
  if (new Set([...han, ...alnum]).size < 2) return false;                     // “一一一”这类重复字
  if (han.length >= 3) return conf >= 60;                                     // 中文：至少 3 个汉字
  return alnum.length >= 3 && conf >= 75;                                     // 英文 / 数字：至少 3 个字符
}

// 识别线程由这里统一管理，画面遮挡检查和封面适配共用：
//   ensureOCR(n) 线程不够时只补齐，不会把别的模块正在用的线程换掉；
//   没有任务时空闲 30 秒自动释放内存；disposeOCR() 立即释放（只在用户点“取消”时用）。
let ocr = null;        // { scheduler, workers }
let creating = null;   // 正在创建线程的 Promise（避免两个模块同时创建）
let inFlight = 0;      // 正在识别的任务数
let gen = 0;           // 每次 disposeOCR 加 1：创建过程中被释放的话，创建结果作废
let idleTimer = 0;
const IDLE_MS = 30_000;

/** 建议的文字识别线程数：一半的 CPU 核心，最多 3 个（每个线程约占 100~200MB 内存） */
export const suggestedOcrWorkers = () => Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

/**
 * 加载文字识别：保证至少有 n 个 Tesseract 线程，交给调度器轮流分配任务
 * @param {number} n 线程数
 */
export async function ensureOCR(n = suggestedOcrWorkers()) {
  clearTimeout(idleTimer);
  while (creating) await creating.catch(() => {});
  if (ocr && ocr.workers.length >= n) return ocr;
  const g = gen;
  creating = (async () => {
    const mod = await import(`${VENDOR}tesseract/tesseract.esm.min.js`);
    const T = mod.default || mod;
    const opts = {
      workerPath: `${VENDOR}tesseract/worker.min.js`,
      corePath: `${VENDOR}tesseract-core`,          // 会按浏览器能力自动选 relaxedsimd / simd / 普通版
      langPath: `${VENDOR}tesseract-lang`,
      cacheMethod: 'none',                           // 语言数据就在本地，不再额外存一份到 IndexedDB
      workerBlobURL: false,                          // 直接从本站加载 worker（页面开了 COOP/COEP）
    };
    const cur = ocr || { scheduler: T.createScheduler(), workers: [] };
    const add = await Promise.all(Array.from({ length: n - cur.workers.length }, () => T.createWorker(['chi_sim', 'eng'], 1 /* LSTM_ONLY */, opts)));
    if (g !== gen) { // 创建期间被取消了
      await Promise.all(add.map((w) => w.terminate().catch(() => {})));
      throw new Error('已取消');
    }
    add.forEach((w) => { cur.scheduler.addWorker(w); cur.workers.push(w); });
    ocr = cur;
  })();
  try { await creating; } finally { creating = null; }
  return ocr;
}

/** 立即释放识别线程（正在进行的识别任务不会再返回） */
export async function disposeOCR() {
  clearTimeout(idleTimer);
  gen++;
  if (!ocr) return;
  const s = ocr.scheduler;
  ocr = null;
  try { await s.terminate(); } catch { /* 已经结束 */ }
}

/** 没有任务时，30 秒后自动释放 */
function scheduleIdle() {
  clearTimeout(idleTimer);
  if (inFlight === 0) idleTimer = setTimeout(disposeOCR, IDLE_MS);
}

/**
 * 识别一帧里的文字行。每帧识别两遍再合并：
 *   ① 原图；
 *   ② “亮字遮罩”：只保留很亮的像素（白字、黄字）当作黑字，其余变白。
 *      封面标题、花字常是“白字 + 黑描边”，在中等亮度的背景上，Tesseract 会把描边当成笔画、认成空心字而认不出；
 *      实测“周末露营装备清单”原图识别为乱码，亮字遮罩后完全正确（置信度 80）。
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Array<{x,y,w,h,text,conf}>>}
 */
export async function recognizeText(canvas) {
  if (!ocr) throw new Error('文字识别还没加载');
  const H = canvas.height;
  const job = (img) => ocr.scheduler.addJob('recognize', img, {}, { blocks: true, text: false }).then((r) =>
    (r.data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
      .map((l) => ({ x: l.bbox.x0, y: l.bbox.y0, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0, text: l.text.trim(), conf: l.confidence }))
      .filter((l) => l.h >= H * MIN_TEXT_H && looksLikeText(l.text, l.conf)));
  inFlight++;
  try {
    const [a, b] = await Promise.all([job(canvas), job(brightMask(canvas))]);
    return mergeOverlapping([...a, ...b]);
  } finally {
    inFlight--;
    scheduleIdle();
  }
}

const BRIGHT_Y = 200; // 亮度（0~255）达到这个值才算“亮字”：白色 255、亮黄约 205，浅粉 / 天蓝背景约 180 以下

/** 亮字遮罩：亮的像素变黑（当作文字），其余变白 */
function brightMask(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height), p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2] >= BRIGHT_Y ? 0 : 255;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * 合并互相重叠的文字框：Tesseract 有时把同一行字认成两行（一长一短、上下错开一点），
 * 重叠部分超过较小框面积一半的，合成一个大框，避免同一句字幕报两次
 */
function mergeOverlapping(boxes) {
  const out = [...boxes];
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (iw <= 0 || ih <= 0 || (iw * ih) / Math.min(a.w * a.h, b.w * b.h) < 0.5) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y,
          text: a.text.length >= b.text.length ? a.text : b.text, conf: Math.max(a.conf, b.conf) };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}
