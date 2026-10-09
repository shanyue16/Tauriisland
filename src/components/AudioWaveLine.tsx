import { useEffect, useRef, useState } from "react";

/**
 * 展开态背景音频可视化：**折线图**（替换原先的柱状图）。
 *
 * - 无真实音频分析，沿用"模拟频谱"思路：多正弦叠加，视觉上是流动的波形。
 * - 颜色由外部传入（取自封面主色），保证与封面光晕同色。
 * - 动画用 requestAnimationFrame 且限帧 ~30fps，暂停时退化为一条静态低幅折线
 *   （不跑 rAF，不占 CPU）；卸载时清理 rAF。
 * - 不在动画里做任何 canvas/取色计算。
 */

const POINTS = 48; // 采样点数量
const W = 100; // viewBox 宽（配合 preserveAspectRatio="none" 横向铺满）
const H = 40; // viewBox 高
const FPS = 30;
const FRAME_MS = 1000 / FPS;

function buildPoints(t: number, playing: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < POINTS; i++) {
    const p = i / (POINTS - 1);
    const x = p * W;
    // 三个不同频率/相位的正弦叠加 → 近似频谱的起伏；两端用 sin(pi*p) 收敛，
    // 避免折线在左右边缘被截断出突兀的竖线。
    const envelope = Math.sin(Math.PI * p);
    const amp = playing
      ? envelope *
          (5.5 +
            4.2 * Math.sin(t * 1.7 + p * 9.1) +
            2.6 * Math.sin(t * 2.9 + p * 17.3) +
            1.8 * Math.sin(t * 0.9 + p * 4.7))
      : envelope * (2.6 + 0.7 * Math.sin(p * 9.1));
    const y = H - 3 - Math.max(0.6, amp);
    out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return out.join(" ");
}

export default function AudioWaveLine({
  color,
  color2,
  playing,
}: {
  color: string;
  color2: string;
  playing: boolean;
}) {
  const [points, setPoints] = useState(() => buildPoints(0, false));
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);

  useEffect(() => {
    if (!playing) {
      // 暂停：静态低幅折线，不启动动画循环
      setPoints(buildPoints(0, false));
      return;
    }
    const tick = (now: number) => {
      rafRef.current = window.requestAnimationFrame(tick);
      if (now - lastRef.current < FRAME_MS) return; // 限帧 ~30fps
      lastRef.current = now;
      setPoints(buildPoints(now / 1000, true));
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  const gradId = "island-wave-grad";

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ opacity: playing ? 0.55 : 0.22, transition: "opacity 400ms ease" }}
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
        points={points}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ filter: `drop-shadow(0 0 3px ${color}66)` }}
      />

      {/* 低透明度镜像，制造"流动"层次 */}
      <polyline
        points={points}
        fill="none"
        stroke={color2}
        strokeOpacity={0.22}
        strokeWidth={0.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        transform={`translate(0 ${H}) scale(1 -1)`}
      />
    </svg>
  );
}
