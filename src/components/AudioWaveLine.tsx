import { useEffect, useId, useRef } from "react";

/**
 * 音频可视化折线（模拟频谱，非真实 FFT）。
 *
 * - 无真实音频分析：多正弦叠加 + sin(πp) 端点包络，视觉上是流动的波形。
 * - 颜色由外部传入（取自封面主色），保证与封面光晕同色。
 * - 动画用 requestAnimationFrame 且限帧 ~30fps，暂停时退化为一条静态低幅折线
 *   （不跑 rAF，不占 CPU）；卸载时清理 rAF。
 * - **同屏可放多条**：amplitude / phase / thickness / opacityScale / mirror 用来
 *   把同一条折线调成"丝状"背景的不同层次（展开态音乐页用它铺 3 条）；
 *   渐变 id 用 useId 生成，避免多条实例共用同一个 <linearGradient> 定义。
 *
 * 性能：折线的 `points` 直接写 DOM（setAttribute），**不走 React state**。
 * 30fps × 多实例若每帧 setState，会让整棵音乐页每秒重渲染 90 次；
 * 这里只重绘两条 polyline 的属性，父组件零重渲染。
 */

const POINTS = 48; // 采样点数量
const W = 100; // viewBox 宽（配合 preserveAspectRatio="none" 横向铺满）
const H = 40; // viewBox 高
const FPS = 30;
const FRAME_MS = 1000 / FPS;

function buildPoints(t: number, playing: boolean, amplitude: number, phase: number): string {
  const out: string[] = [];
  for (let i = 0; i < POINTS; i++) {
    const p = i / (POINTS - 1);
    const x = p * W;
    // 三个不同频率/相位的正弦叠加 → 近似频谱的起伏；两端用 sin(pi*p) 收敛，
    // 避免折线在左右边缘被截断出突兀的竖线。phase 让同屏多条互不同步。
    const envelope = Math.sin(Math.PI * p);
    const amp =
      (playing
        ? envelope *
          (5.5 +
            4.2 * Math.sin(t * 1.7 + p * 9.1 + phase) +
            2.6 * Math.sin(t * 2.9 + p * 17.3 + phase * 0.6) +
            1.8 * Math.sin(t * 0.9 + p * 4.7 + phase * 1.3))
        : envelope * (2.6 + 0.7 * Math.sin(p * 9.1 + phase))) * amplitude;
    const y = H - 3 - Math.max(0.6, amp);
    out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return out.join(" ");
}

export default function AudioWaveLine({
  color,
  color2,
  playing,
  /** 波幅倍率（1 = 默认）。丝状背景用 0.6~1.2 拉开层次。 */
  amplitude = 1,
  /** 相位偏移（弧度），让同屏多条不同步。 */
  phase = 0,
  /** 描边宽度（px，vectorEffect=non-scaling-stroke 所以是真实像素）。 */
  thickness = 1,
  /** 在基础透明度上再乘一个系数。 */
  opacityScale = 1,
  /** 是否画下方镜像线（丝状背景通常关掉，留一条干净的线更"丝"）。 */
  mirror = true,
}: {
  color: string;
  color2: string;
  playing: boolean;
  amplitude?: number;
  phase?: number;
  thickness?: number;
  opacityScale?: number;
  mirror?: boolean;
}) {
  const mainRef = useRef<SVGPolylineElement>(null);
  const mirrorRef = useRef<SVGPolylineElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  // useId 会产出 ":r1:" 这类含冒号的 id，去掉冒号再拼进 url(#...) 更稳妥
  const gradId = `wave-${useId().replace(/:/g, "")}`;

  // 首帧静态值（暂停态的形态），SSR/首次绘制就有内容
  const initial = buildPoints(0, false, amplitude, phase);

  useEffect(() => {
    const apply = (points: string) => {
      mainRef.current?.setAttribute("points", points);
      mirrorRef.current?.setAttribute("points", points);
    };

    if (!playing) {
      // 暂停：静态低幅折线，不启动动画循环
      apply(buildPoints(0, false, amplitude, phase));
      return;
    }
    const tick = (now: number) => {
      rafRef.current = window.requestAnimationFrame(tick);
      if (now - lastRef.current < FRAME_MS) return; // 限帧 ~30fps
      lastRef.current = now;
      apply(buildPoints(now / 1000, true, amplitude, phase));
    };
    apply(buildPoints(0, true, amplitude, phase));
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, amplitude, phase]);

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{
        opacity: (playing ? 0.55 : 0.22) * opacityScale,
        transition: "opacity 400ms ease",
      }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={color} stopOpacity="0.12" />
          <stop offset="45%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color2} stopOpacity="0.12" />
        </linearGradient>
      </defs>

      {/* 主折线（颜色＝封面光晕色） */}
      <polyline
        ref={mainRef}
        points={initial}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ filter: `drop-shadow(0 0 3px ${color}66)` }}
      />

      {/* 低透明度镜像，制造"流动"层次 */}
      {mirror && (
        <polyline
          ref={mirrorRef}
          points={initial}
          fill="none"
          stroke={color2}
          strokeOpacity={0.22 * opacityScale}
          strokeWidth={thickness * 0.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          transform={`translate(0 ${H}) scale(1 -1)`}
        />
      )}
    </svg>
  );
}
