// ============================================================
// history.js —— 处理历史：把每次处理后的视频存进本机浏览器的 IndexedDB
// 只存在这台电脑的这个浏览器里，不会上传；清除浏览器网站数据会一起删除。
// ============================================================
const DB_NAME = 'video-checkup';
const STORE = 'outputs';

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; }); // 失败了下次再试
  }
  return dbPromise;
}

/** 执行一次事务并等待完成 */
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务被中止'));
  });
}

/**
 * 保存一条处理结果
 * @param {object} rec 元数据 + file（File/Blob）
 * @returns {Promise<number>} 新记录的 id
 */
export async function saveOutput(rec) {
  // 申请“持久化存储”，降低浏览器在空间紧张时自动清理的概率（Chrome 一般不会弹窗）
  try { await navigator.storage?.persist?.(); } catch (e) { /* 忽略 */ }
  return tx('readwrite', (s) => s.add({ ...rec, createdAt: Date.now() }));
}

/** 列出全部记录（新的在前）。Blob 在 IndexedDB 里是按需读取的，列表本身不会占很多内存 */
export async function listOutputs() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export const deleteOutput = (id) => tx('readwrite', (s) => s.delete(id));
export const clearOutputs = () => tx('readwrite', (s) => s.clear());

/** 浏览器给这个网站的存储用量 / 配额（字节），不支持时返回 null */
export async function storageUsage() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch (e) {
    return null;
  }
}
