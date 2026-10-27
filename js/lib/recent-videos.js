// ============================================================
// recent-videos.js —— 最近导入的视频（存在本机浏览器，打开页面时可自动载入上一次的视频）
//
// 导入的视频复制一份到浏览器给本站的私有磁盘空间（OPFS 的 recent 目录），不会上传；
// 从“处理历史”载入的结果本来就在 OPFS 里，只记位置，不再复制。
// 列表（文件名、大小、时间、在哪个目录）存在 localStorage；文件本身在 OPFS。
// 最多保留 MAX_COUNT 个、总大小不超过 MAX_BYTES，超出时删掉最久没用的。
// ============================================================

const DIR = 'recent';
const KEY = 'recentVideos';
const AUTO_KEY = 'autoLoadLastVideo';
const MAX_COUNT = 5;
const MAX_BYTES = 3 * 1024 ** 3; // 3 GB

const hasOPFS = () => !!navigator.storage?.getDirectory;
const dirHandle = async (name) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });

function readList() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function writeList(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 隐私模式等情况下存不了 */ }
}
/** 同一个文件：文件名、大小、修改时间都一样 */
const sameFile = (r, f) => r.name === f.name && r.size === f.size && r.lastModified === f.lastModified;

/** 最近导入的视频，最近用过的在前 */
export const listRecent = () => readList().sort((a, b) => b.usedAt - a.usedAt);

/** 打开页面时是否自动载入上一次的视频（默认是） */
export function autoLoadEnabled() {
  try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return false; }
}
export function setAutoLoad(on) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/**
 * 记住一个视频
 * @param {File} file
 * @param {{dir:string, name:string}} [ref] 文件已经在 OPFS 里（例如处理历史的结果）时传位置，不再复制
 * @returns {Promise<object|null>} 列表里的这一项；浏览器不支持或空间不够时返回 null
 */
export async function rememberVideo(file, ref = null) {
  if (!hasOPFS()) return null;
  const list = readList();
  const now = Date.now();
  const old = list.find((r) => sameFile(r, file));
  if (old) { // 已经存过：只更新使用时间
    old.usedAt = now;
    writeList(list);
    return old;
  }
  let loc = ref;
  if (!loc) {
    // 先确认空间够（留 200MB 余量），再边读边写，不把整个文件读进内存
    const est = await navigator.storage.estimate?.().catch(() => null);
    if (est && est.quota - est.usage < file.size + 200 * 1024 ** 2) return null;
    const name = `${now}_${file.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    const dir = await dirHandle(DIR);
    const fh = await dir.getFileHandle(name, { create: true });
    try {
      const w = await fh.createWritable();
      await file.stream().pipeTo(w);
    } catch (e) {
      await dir.removeEntry(name).catch(() => {});
      throw e;
    }
    loc = { dir: DIR, name };
  }
  const entry = { id: now, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, savedAt: now, usedAt: now, opfs: loc };
  writeList([entry, ...readList().filter((r) => !sameFile(r, file))]);
  await prune();
  navigator.storage.persist?.().catch(() => {}); // 申请“持久保存”，减少浏览器空间紧张时自动清理的可能
  return entry;
}

/** 取出某个视频，返回带原文件名的 File（只是引用磁盘上的文件，不会读进内存） */
export async function openRecent(id) {
  const list = readList();
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error('记录不存在');
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(r.opfs.dir);
  const f = await (await dir.getFileHandle(r.opfs.name)).getFile();
  r.usedAt = Date.now();
  writeList(list);
  return new File([f], r.name, { type: r.type || f.type, lastModified: r.lastModified });
}

/** 删除一条；文件在 recent 目录里才删文件（处理历史里的文件由处理历史管理） */
export async function removeRecent(id) {
  const list = readList();
  const r = list.find((x) => x.id === id);
  writeList(list.filter((x) => x.id !== id));
  if (r?.opfs.dir === DIR) await (await dirHandle(DIR)).removeEntry(r.opfs.name).catch(() => {});
}

/** 超过数量或总大小上限时，删掉最久没用的（至少保留最近一个） */
async function prune() {
  const list = listRecent();
  let total = 0;
  const keep = [], drop = [];
  list.forEach((r, i) => {
    const size = r.opfs.dir === DIR ? r.size : 0; // 引用处理历史的不占额外空间
    if (i === 0 || (keep.length < MAX_COUNT && total + size <= MAX_BYTES)) { keep.push(r); total += size; } else drop.push(r);
  });
  if (!drop.length) return;
  writeList(keep);
  const dir = await dirHandle(DIR);
  for (const r of drop) if (r.opfs.dir === DIR) await dir.removeEntry(r.opfs.name).catch(() => {});
}

/**
 * 启动时整理：去掉文件已经不在的记录（例如对应的处理历史被删了），删掉没有记录的残留文件（例如复制到一半关了页面）
 */
export async function cleanupRecent() {
  if (!hasOPFS()) return;
  const root = await navigator.storage.getDirectory();
  const ok = [];
  for (const r of readList()) {
    try {
      await (await root.getDirectoryHandle(r.opfs.dir)).getFileHandle(r.opfs.name);
      ok.push(r);
    } catch { /* 文件没了，丢掉这条 */ }
  }
  writeList(ok);
  const keep = new Set(ok.filter((r) => r.opfs.dir === DIR).map((r) => r.opfs.name));
  const dir = await dirHandle(DIR);
  for await (const [name] of dir.entries()) if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
}
