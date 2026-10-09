/**
 * 封面主色提取（用于封面光晕与展开态音频折线）。
 *
 * 无第三方依赖：离屏 canvas 降采样 + 颜色量化。
 * - 远程 https 图必须 crossOrigin="anonymous" 才能读像素；被 CORS 拒绝时
 *   返回 null，由调用方回退到主题 accent（保证降级后光晕与折线仍是同一颜色）。
 * - data: URL（SMTC 封面）同源可直接读。
 * - 结果按 URL 缓存（含 null），并做 in-flight 去重，避免重复计算。
 */

const colorCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

const SAMPLE = 32; // 降采样尺寸，足够取主色且几乎零成本

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 提高饱和度/亮度，让取到的颜色适合做光晕与折线（不改变色相） */
function boostForGlow(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r / 255) h = ((g - b) / 255 / d + (g < b ? 6 : 0)) / 6;
    else if (max === g / 255) h = ((b - r) / 255 / d + 2) / 6;
    else h = ((r - g) / 255 / d + 4) / 6;
  }
  // 光晕需要更"亮"更"艳"，但不过曝
  const s2 = Math.min(1, Math.max(0.45, s * 1.15));
  const l2 = Math.min(0.72, Math.max(0.5, l * 1.05 + 0.12));
  return hslToHex(h, s2, l2);
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return toHex(hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255);
}

/** 生成同色系的次级色（更亮一档），用于渐变/镜像线 */
export function lighten(hex: string, amount = 0.16): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r / 255) h = ((g - b) / 255 / d + (g < b ? 6 : 0)) / 6;
    else if (max === g / 255) h = ((b - r) / 255 / d + 2) / 6;
    else h = ((r - g) / 255 / d + 4) / 6;
  }
  return hslToHex(h, s, Math.min(0.8, l + amount));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 远程图必须带 CORS 才能读像素；data: 不需要
    if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

async function compute(url: string): Promise<string | null> {
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

    // 按 4bit/通道分桶统计；剔除近黑/近白/灰（无彩色信息）像素
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 128) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 48 || min > 224) continue; // 近黑 / 近白
      if (max - min < 26) continue; // 灰
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key);
      if (cur) {
        cur.n += 1;
        cur.r += r;
        cur.g += g;
        cur.b += b;
      } else {
        buckets.set(key, { n: 1, r, g, b });
      }
    }
    if (buckets.size === 0) return null;

    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (const v of buckets.values()) {
      if (!best || v.n > best.n) best = v;
    }
    if (!best) return null;
    return boostForGlow(best.r / best.n, best.g / best.n, best.b / best.n);
  } catch {
    // 图片加载失败 / canvas 被 CORS 污染 → 交由调用方回退
    return null;
  }
}

/** 取封面主色；失败或没有封面时返回 null */
export function extractCoverColor(url: string | null | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url) ?? null);
  const running = inflight.get(url);
  if (running) return running;

  const task = compute(url).then((color) => {
    colorCache.set(url, color);
    inflight.delete(url);
    return color;
  });
  inflight.set(url, task);
  return task;
}
