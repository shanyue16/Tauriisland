import { ANIMATION_DURATION, type AnimationSpeed } from "../types";

/**
 * 动效 token 的 **JS 侧镜像**。
 *
 * 曲线与 index.css 里的 `--ease-out` / `--ease-in-out` 是同一组数值；
 * 时长档位沿用 `types/index.ts` 已有的 `ANIMATION_DURATION`（slow/normal/fast =
 * 380/280/180）—— 这样"动画速度"设置真正生效，而不是再另起一套数值。
 *
 * 为什么窗口形变必须留在 JS：Windows 上 OS 窗口的 setSize/setPosition 不支持原生动画，
 * CSS 也管不到窗口本身，只能用 rAF 手动插值。内容层则全部交给 CSS 过渡。
 */

// cubic-bezier(0.23, 1, 0.32, 1)：UI 用的强 ease-out（入场/出场）
// cubic-bezier(0.77, 0, 0.175, 1)：屏幕内位移用的强 ease-in-out
const EASE_OUT_PTS = [0.23, 1, 0.32, 1] as const;
const EASE_IN_OUT_PTS = [0.77, 0, 0.175, 1] as const;

/**
 * 三次贝塞尔求值器（Newton–Raphson 迭代 + 二分兜底），
 * 与 CSS 的 `cubic-bezier(x1,y1,x2,y2)` 逐点一致 —— 这样 JS 驱动窗口、
 * CSS 驱动内容时，两者用的是同一条曲线。
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // 先牛顿迭代（收敛快）
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-4) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }

    // 再二分兜底（保证任何输入都有结果）
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** 强 ease-out —— 入场 / 出场 */
export const easeOut = cubicBezier(...EASE_OUT_PTS);
/** 强 ease-in-out —— 屏幕内位移（分页滑动） */
export const easeInOut = cubicBezier(...EASE_IN_OUT_PTS);

/**
 * 各转场的基准时长（normal 档，单位 ms）。
 *
 * 分级依据是"发生频率"：悬浮态每天都进出很多次，必须快而轻；展开态是偶发动作，
 * 可以走完整节奏。全部都 ≤ 300ms，只有用户主动选 slow 档才会更长。
 */
export const MOTION = {
  /** 失焦 ↔ 悬浮（每天几十次） */
  hover: 180,
  /** 悬浮 ↔ 展开 / 设置 / 提醒（偶发） */
  expand: 280,
  /** 内容让位：旧内容快速淡出（无延迟） */
  layerOut: 110,
  /** 内容就位：新内容淡入 */
  layerIn: 150,
  /** 新内容等岛体长到差不多再淡入 */
  layerInDelay: 90,
  /** 提醒卸下（与入场对称，稍快） */
  alertOut: 140,
  /** 页内换页（time/weather/music 之间） */
  page: 160,
} as const;

/**
 * 页切换的位移幅度（px）。
 *
 * 页的静止位移按 **位置关系** 算，而不是按"这次往哪个方向翻"：
 * 索引在前的页停在上方（-PAGE_SHIFT），索引在后的页停在下方（+PAGE_SHIFT）。
 * 于是向前翻时旧页本来就靠上、自然往上走，向后翻时相反 —— 同一个公式在两个方向上
 * 都得到正确的运动方向，而且不需要记住"上一次翻向"（记住翻向的写法在无关重渲染时
 * 会把方向清成 0，旧页会往回弹一下）。
 */
export const PAGE_SHIFT = 10;

/** 四态的高低顺序：0 最小、3 设置面板。用于判断"这次是长大还是收小" */
export const STATE_ORDER = {
  minimal: 0,
  medium: 1,
  expanded: 2,
  maximal: 3,
} as const;

/** 用户"动画速度"设置的倍率（以 normal 为 1） */
export function speedFactor(speed: AnimationSpeed): number {
  return ANIMATION_DURATION[speed] / ANIMATION_DURATION.normal;
}

/**
 * 某个动效档位在当前"动画速度"下的**实际时长（ms）**。
 *
 * 所有动效都必须从这里取时长：窗口形变、内容层的淡入淡出、页内换页、提醒出入场、
 * 圆角形变 —— 这样设置→交互→动画速度的三挡（慢/正常/快）才会**同时**作用于全部动效，
 * 而不是只有窗口跟着变。
 */
export function motionMs(kind: keyof typeof MOTION, speed: AnimationSpeed): number {
  return MOTION[kind] * speedFactor(speed);
}

/** 给 index.css 用的同一倍率（CSS 里写 calc(220ms * var(--motion-factor, 1))） */
export function motionFactor(speed: AnimationSpeed): string {
  return String(speedFactor(speed));
}

/**
 * 系统"减少动态效果"开关。
 *
 * 按无障碍口径：不是把动画全关掉，而是去掉"位移/缩放"这类会让前庭不适的运动，
 * 保留帮助理解状态变化的透明度过渡。窗口形变在 reduced 下直接落位。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
