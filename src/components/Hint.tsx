import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readPortalThemeVars, type PortalThemeVars } from "../utils/portalTheme";

/**
 * 悬浮提示（自绘 tooltip，替代原生 `title`）。
 *
 * 为什么不用 `title`：原生提示是系统绘制的 —— 延迟 1s 左右、字体/圆角/描边全都控制不了，
 * 在玻璃岛上突然冒出一块系统灰白框，和整体不搭。这里自己画：
 *
 * - 挂到 `document.body`（portal）+ `position: fixed`：日程页/编辑器都在
 *   `overflow: hidden` 的岛内覆盖层里，绝对定位会被裁掉，portal 不受祖先影响。
 * - 跟随鼠标（右下偏移），并夹在视口内 —— 贴着窗口右缘的「+」也不会把提示挤出屏幕。
 * - 320ms 延迟（模仿 Windows 的悬停节奏），移开立即消失。
 * - `pointerEvents: none` + 文本只在 `title`/`body` 非空时渲染，空内容不占位。
 *
 * 样式口径与 Dropdown 浮层一致（`--popover-bg` / `--island-border` / `--popover-shadow`）。
 */

const SHOW_DELAY_MS = 320;
const OFFSET_X = 14;
const OFFSET_Y = 18;
const EDGE = 8;
const MAX_WIDTH = 220;

export default function Hint({
  label,
  detail,
  children,
  disabled = false,
}: {
  /** 主行（一般是一个短标题） */
  label?: string;
  /** 次行（灰一点的补充信息，比如时间/地点/备注） */
  detail?: string;
  children: React.ReactNode;
  /** 关掉提示（比如被禁用的按钮，提示由 aria-label 承担） */
  disabled?: boolean;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  // portal 到 body 后拿不到岛根节点上的 inline 变量，悬停时把解析值存下来
  const themeVarsRef = useRef<PortalThemeVars>({});

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTip(null);
  }, []);

  useEffect(() => clear, [clear]);

  const hasText = Boolean(label || detail);

  const handleEnter = (e: React.MouseEvent) => {
    if (!hasText || disabled) return;
    const x = e.clientX;
    const y = e.clientY;
    // 必须在同步阶段读（React 事件处理后 currentTarget 会被置空）
    themeVarsRef.current = readPortalThemeVars(e.currentTarget as Element);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setTip({ x, y }), SHOW_DELAY_MS);
  };

  const handleMove = (e: React.MouseEvent) => {
    if (!tip) return;
    setTip({ x: e.clientX, y: e.clientY });
  };

  /* 夹在视口内：先按偏移放，再按实际尺寸回推 */
  const style: React.CSSProperties | null = tip
    ? (() => {
        const w = tipRef.current?.offsetWidth ?? 0;
        const h = tipRef.current?.offsetHeight ?? 0;
        let left = tip.x + OFFSET_X;
        let top = tip.y + OFFSET_Y;
        if (w > 0 && left + w > window.innerWidth - EDGE) left = tip.x - w - OFFSET_X;
        if (h > 0 && top + h > window.innerHeight - EDGE) top = tip.y - h - OFFSET_Y;
        return {
          position: "fixed",
          left: Math.max(EDGE, left),
          top: Math.max(EDGE, top),
          maxWidth: MAX_WIDTH,
        };
      })()
    : null;

  return (
    <>
      <span
        style={{ display: "contents" }}
        onMouseEnter={handleEnter}
        onMouseMove={handleMove}
        onMouseLeave={clear}
      >
        {children}
      </span>
      {tip &&
        style &&
        createPortal(
          <div
            ref={tipRef}
            style={{
              ...style,
              ...(themeVarsRef.current as React.CSSProperties),
              zIndex: 3200,
              pointerEvents: "none",
              padding: "6px 9px",
              borderRadius: 8,
              background: "var(--popover-bg)",
              border: "1px solid var(--island-border)",
              boxShadow: "var(--popover-shadow)",
              backdropFilter: "blur(18px)",
              WebkitBackdropFilter: "blur(18px)",
              animation: "hint-in 120ms ease-out",
            }}
          >
            {label && (
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--island-text)",
                  lineHeight: 1.35,
                  wordBreak: "break-word",
                }}
              >
                {label}
              </div>
            )}
            {detail && (
              <div
                style={{
                  marginTop: label ? 3 : 0,
                  fontSize: 10,
                  color: "var(--island-text-muted)",
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {detail}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
