// ============================================================
// config.js —— 读取并检查 config/platforms.json
// 配置是手工编辑的，容易写错；这里把常见错误翻译成中文提示，告诉你是哪个平台、哪一条出了问题。
// ============================================================

const CONFIG_URL = new URL('../../config/platforms.json', import.meta.url).href;
const OPS = ['in', 'notIn', 'eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'between', 'isTrue', 'isFalse'];
const TYPES = ['hard', 'advice', 'info'];

/** 读取配置（加时间戳避免浏览器缓存，改完 JSON 刷新即生效） */
export async function loadConfig() {
  let res;
  try {
    res = await fetch(CONFIG_URL + '?t=' + Date.now());
  } catch (e) {
    throw new Error('读取 config/platforms.json 失败。请确认是通过本地服务器（如 npx serve）打开，而不是直接双击 index.html。');
  }
  if (!res.ok) throw new Error(`读取 config/platforms.json 失败（HTTP ${res.status}）。`);
  const text = await res.text();
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`config/platforms.json 不是合法的 JSON（常见原因：少了逗号、多了逗号、引号不配对）：${e.message}`);
  }
  const problems = validateConfig(cfg);
  if (problems.length) {
    throw new Error('config/platforms.json 有以下问题，请修改后刷新：\n· ' + problems.join('\n· '));
  }
  return cfg;
}

/** 检查配置结构，返回问题列表（空数组表示没问题） */
export function validateConfig(cfg) {
  const p = [];
  if (!cfg || typeof cfg.platforms !== 'object' || !Object.keys(cfg.platforms || {}).length) {
    return ['缺少 platforms，或里面没有任何平台'];
  }
  // 百分比矩形：x / y / w / h 都在 0~100 之间，且不超出截图
  const checkRect = (at, r) => {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (typeof r?.[k] !== 'number' || r[k] < 0 || r[k] > 100) p.push(`${at}：${k} 应该是 0~100 之间的数字（相对截图宽高的百分比）`);
    }
    if (r && r.x + r.w > 100.5) p.push(`${at}：x + w 超过了 100%`);
    if (r && r.y + r.h > 100.5) p.push(`${at}：y + h 超过了 100%`);
  };
  const check = (where, plat) => {
    if (!plat.name) p.push(`${where}：缺少 name（显示名称）`);
    const rules = plat.spec?.rules;
    if (!Array.isArray(rules)) { p.push(`${where}：缺少 spec.rules（技术规格规则列表）`); return; }
    const ids = new Set();
    rules.forEach((r, i) => {
      const at = `${where} 第 ${i + 1} 条规则${r?.id ? `（${r.id}）` : ''}`;
      if (!r?.id) p.push(`${at}：缺少 id`);
      else if (ids.has(r.id)) p.push(`${at}：id 重复`);
      else ids.add(r.id);
      if (!r?.item) p.push(`${at}：缺少 item（检查项名称）`);
      if (!TYPES.includes(r?.type)) p.push(`${at}：type 只能是 hard / advice / info`);
      if (!r?.check?.metric) p.push(`${at}：缺少 check.metric`);
      if (!OPS.includes(r?.check?.op)) p.push(`${at}：check.op 写法不对（可用：${OPS.join(', ')}）`);
      if (r?.check?.op === 'between' && !(Array.isArray(r.check.value) && r.check.value.length === 2)) p.push(`${at}：between 的 value 要写成 [最小, 最大]`);
      const tiers = r?.check?.tiers;
      if (tiers !== undefined) {
        if (!Array.isArray(tiers) || !tiers.length) p.push(`${at}：tiers（分档）应该是非空列表`);
        else tiers.forEach((t, k) => {
          const last = k === tiers.length - 1;
          if (t?.value === undefined) p.push(`${at}：第 ${k + 1} 档缺少 value`);
          if (!last && typeof t?.upTo !== 'number') p.push(`${at}：第 ${k + 1} 档缺少 upTo（只有最后一档可以不写）`);
          if (k > 0 && typeof t?.upTo === 'number' && !(t.upTo > tiers[k - 1]?.upTo)) p.push(`${at}：分档的 upTo 要从小到大排列`);
        });
      }
    });
    const ov = plat.overlay;
    if (ov?.screenAspect !== undefined && !(typeof ov.screenAspect === 'number' && ov.screenAspect > 0.2 && ov.screenAspect < 2)) {
      p.push(`${where}：overlay.screenAspect（截图宽 ÷ 高）应该是 0.2~2 之间的数字，例如 1080×2340 的截图是 0.4615`);
    }
    if (ov?.videoFit !== undefined && !['contain', 'cover'].includes(ov.videoFit)) p.push(`${where}：overlay.videoFit 只能是 contain 或 cover`);
    if (ov?.coverMaxCrop !== undefined && !(typeof ov.coverMaxCrop === 'number' && ov.coverMaxCrop >= 0 && ov.coverMaxCrop <= 1)) {
      p.push(`${where}：overlay.coverMaxCrop 应该是 0~1 之间的数字（例如 0.25 表示最多裁掉 25%）`);
    }
    if (ov?.videoArea !== undefined) checkRect(`${where} 视频播放区域（overlay.videoArea）`, ov.videoArea);
    const zones = ov?.zones;
    if (zones !== undefined) {
      if (!Array.isArray(zones)) p.push(`${where}：overlay.zones 应该是列表`);
      else zones.forEach((z, i) => {
        const at = `${where} 遮挡区域第 ${i + 1} 个${z?.name ? `（${z.name}）` : ''}`;
        if (!z?.id || !z?.name) p.push(`${at}：缺少 id 或 name`);
        checkRect(at, z);
      });
    }
  };
  // 封面适配
  const checkCover = (where, cover) => {
    if (cover === undefined) return;
    if (!Array.isArray(cover?.ratios) || !cover.ratios.length) { p.push(`${where}：cover.ratios（封面比例列表）应该是非空列表`); return; }
    const ids = new Set();
    cover.ratios.forEach((r, i) => {
      const at = `${where} 第 ${i + 1} 个封面比例${r?.name ? `（${r.name}）` : ''}`;
      if (!r?.id || !r?.name) p.push(`${at}：缺少 id 或 name`);
      else if (ids.has(r.id)) p.push(`${at}：id 重复`);
      else ids.add(r.id);
      const pair = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x > 0);
      if (!pair(r?.ratio)) p.push(`${at}：ratio 要写成 [宽, 高]，例如 [3, 4]`);
      if (!pair(r?.size)) p.push(`${at}：size（导出尺寸）要写成 [宽, 高]，例如 [1080, 1440]`);
      if (r?.zonesFrom !== undefined && r.zonesFrom !== 'overlay') p.push(`${at}：zonesFrom 只能写 "overlay"`);
      (r?.zones || []).forEach((z, k) => {
        const zat = `${at} 的第 ${k + 1} 个角标${z?.name ? `（${z.name}）` : ''}`;
        if (!z?.id || !z?.name) p.push(`${zat}：缺少 id 或 name`);
        checkRect(zat, z);
      });
    });
  };
  for (const [id, plat] of Object.entries(cfg.platforms)) checkCover(`平台 ${plat?.name || id}`, plat?.cover);
  for (const [id, plat] of Object.entries(cfg.platforms)) check(`平台 ${plat?.name || id}`, plat || {});
  for (const [id, plat] of Object.entries(cfg.otherPlatforms || {})) check(`其他平台 ${plat?.name || id}`, plat || {});
  return p;
}
