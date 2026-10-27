// ============================================================
// probe.js —— 用 mediainfo.js（WebAssembly）读取视频参数
// 文件按需分块读取（file.slice），不会整体读进内存，也不会上传。
// ============================================================
import mediaInfoFactory from '../../vendor/mediainfo/index.min.js';

let mediaInfoPromise = null;

/** 懒加载 mediainfo 实例（只初始化一次） */
function getMediaInfo() {
  if (!mediaInfoPromise) {
    mediaInfoPromise = mediaInfoFactory({
      format: 'object',
      // 告诉 mediainfo 去本地 vendor 目录找 wasm 文件
      locateFile: () => new URL('../../vendor/mediainfo/MediaInfoModule.wasm', import.meta.url).href,
    });
  }
  return mediaInfoPromise;
}

/** 调用 mediainfo 分析文件，返回原始结果 */
async function analyzeRaw(file) {
  const mi = await getMediaInfo();
  const getSize = () => file.size;
  // mediainfo 会按需请求某个偏移量的一段数据
  const readChunk = async (chunkSize, offset) =>
    new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
  return mi.analyzeData(getSize, readChunk);
}

// ---------- 小工具 ----------
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** 把宽高比归一到常见比例（容差 2%），否则显示小数 */
function normalizeAspect(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  const common = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9, '2.35:1': 2.35, '4:5': 4 / 5, '3:2': 3 / 2, '2:3': 2 / 3 };
  for (const [name, val] of Object.entries(common)) {
    if (Math.abs(r - val) / val < 0.02) return name;
  }
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/** 根据传输特性 / 色域 / HDR_Format 判断 HDR 类型 */
function detectHDR(v) {
  const trc = (v.transfer_characteristics || '').toUpperCase();
  const prim = v.colour_primaries || '';
  const hdrFormat = v.HDR_Format || '';
  let type = null;
  if (/HLG|ARIB STD-B67/.test(trc)) type = 'HLG';
  else if (/PQ|2084/.test(trc)) type = 'PQ';
  if (/Dolby Vision/i.test(hdrFormat)) type = type ? `Dolby Vision / ${type}` : 'Dolby Vision';
  else if (/HDR10\+/i.test(hdrFormat)) type = 'HDR10+';
  else if (/SMPTE ST 2086|HDR10/i.test(hdrFormat) && type === 'PQ') type = 'HDR10 (PQ)';
  return {
    isHDR: !!type,
    hdrFormat: type || 'SDR',
    colorPrimaries: prim || '未标注',
    transfer: v.transfer_characteristics || '未标注',
    matrix: v.matrix_coefficients || '未标注',
    bitDepth: num(v.BitDepth),
  };
}

/**
 * 读取视频参数并整理成统一结构（规则引擎用这些字段名作为 metric）
 * @param {File} file
 */
export async function probeFile(file) {
  const raw = await analyzeRaw(file);
  const tracks = raw?.media?.track || [];
  const g = tracks.find((t) => t['@type'] === 'General') || {};
  const v = tracks.find((t) => t['@type'] === 'Video');
  const a = tracks.find((t) => t['@type'] === 'Audio');

  const info = {
    fileName: file.name,
    fileSizeMB: +(file.size / 1024 / 1024).toFixed(2),
    container: g.Format || '未知',
    durationSec: num(g.Duration) !== null ? +num(g.Duration).toFixed(2) : null,
    overallBitrateKbps: num(g.OverallBitRate) !== null ? Math.round(num(g.OverallBitRate) / 1000) : null,
    hasVideo: !!v,
    hasAudio: !!a,
  };

  if (v) {
    let w = num(v.Width), h = num(v.Height);
    // 手机视频常把旋转信息写在元数据里（例如 1920x1080 + 旋转 90°），按“显示尺寸”计算
    const rot = Math.abs(num(v.Rotation) || 0) % 180;
    if (rot === 90) [w, h] = [h, w];
    info.videoCodec = v.Format || '未知';
    info.videoProfile = v.Format_Profile || '';
    info.width = w;
    info.height = h;
    info.rotation = num(v.Rotation) || 0;
    info.shortSide = Math.min(w, h);
    info.longSide = Math.max(w, h);
    info.aspectRatio = normalizeAspect(w, h);
    info.orientation = w === h ? '方形' : (h > w ? '竖屏' : '横屏');
    // 帧率：可变帧率文件（尤其 MKV）常常没有 FrameRate，依次退回到 标称帧率 → 帧数 ÷ 时长（平均帧率）
    let fps = num(v.FrameRate) ?? num(v.FrameRate_Nominal);
    if (fps === null && num(v.FrameCount) && num(v.Duration ?? g.Duration)) {
      fps = num(v.FrameCount) / num(v.Duration ?? g.Duration);
      info.frameRateEstimated = true;
    }
    info.frameRate = fps !== null ? +fps.toFixed(3) : null;
    // 最高帧率：录屏这类画面变化不均匀的可变帧率视频，平均帧率会远低于实际流畅度（例如平均 38、最高 88）
    info.frameRateMax = num(v.FrameRate_Maximum);
    info.frameRateMode = v.FrameRate_Mode || '未标注';
    info.isVFR = v.FrameRate_Mode === 'VFR';
    // 码率：优先用视频轨的值；MKV/WebM 常常没有，就用 总码率 - 音频码率 估算
    let vb = num(v.BitRate);
    if (vb === null && num(g.OverallBitRate) !== null) {
      vb = num(g.OverallBitRate) - (num(a?.BitRate) || 0);
      info.videoBitrateEstimated = true;
    }
    info.videoBitrateKbps = vb !== null ? Math.round(vb / 1000) : null;
    Object.assign(info, detectHDR(v));
  }

  if (a) {
    info.audioCodec = a.Format || '未知';
    info.sampleRate = num(a.SamplingRate);
    info.channels = num(a.Channels);
    info.audioBitrateKbps = num(a.BitRate) !== null ? Math.round(num(a.BitRate) / 1000) : null;
  }

  return { info, raw };
}
