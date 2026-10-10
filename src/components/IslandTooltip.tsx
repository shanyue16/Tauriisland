import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 岛内统一的悬浮提示层（替代原生 title 提示框）。
 *
 * 为什么不用原生 `title`：它的气泡由 WebView 自己绘制——浅色系统底 + 灰字 + 系统字体，
 * 叠在深色玻璃岛上就是一块突兀的亮斑，而且**无法用任何 CSS 控制**。
 *
 * 用法：控件把 `title="..."` 换成 `data-tip="..."`（面板顶部的控件再加
 * `data-tip-pos="bottom"`，让气泡翻到下方），这一层负责统一绘制：
 *   · 深色圆角面板 + 发丝描边 + 柔和阴影，与岛体同一套材质；
 *   · 悬停 180ms 才出现（扫过一排日历格时不会一路弹气泡）；
 *   · 渲染在岛体最上层，不放进任何 overflow:hidden 的格子/列表里，避免被裁；
 *   · 越界自动钳回岛体内（岛主体是 overflow:hidden，气泡一旦越界就没了）。
 *
 * 挂在 Island 的岛体（innerStyle）里，四态共用同一层。
 */

type TipPos = "top" | "bottom";

interface TipState {
  label: string;
  /** 触发元素相对本层的矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  pos: TipPos;
}

const SHOW_DELAY = 180;
const EDGE_PAD = 6;

export default function IslandTooltip() {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const shiftRef = useRef({ dx: 0, dy: 0 });
  const [tip, setTip] = useState<TipState | null>(null);
  const [shift, setShift] = useState({ dx: 0, dy: 0 });

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const hide = () => {
      clearTimer();
      setTip(null);
    };

    const show = (target: EventTarget | null) => {
      const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
      const layer = layerRef.current;
      if (!el || !layer) return;
      const label = el.getAttribute("data-tip");
      if (!label) return;
      const lr = layer.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pos = (el.getAttribute("data-tip-pos") as TipPos | null) ?? "top";
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        shiftRef.current = { dx: 0, dy: 0 };
        setShift({ dx: 0, dy: 0 });
        setTip({ label, x: r.left - lr.left, y: r.top - lr.top, w: r.width, h: r.height, pos });
      }, SHOW_DELAY);
    };

    const onOver = (e: MouseEvent) => show(e.target);
    const onOut = () => hide();
    const onFocus = (e: FocusEvent) => show(e.target);

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onOut);
    window.addEventListener("blur", onOut);
    return () => {
      clearTimer();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onOut);
      window.removeEventListener("blur", onOut);
    };
  }, []);

  // 位置修正：先按"贴在触发元素上方居中"渲染，测量后把越界的部分钳回岛体内。
  // 用 layout effect（绘制前）算，所以不会看到气泡先出界再跳回来。
  useLayoutEffect(() => {
    if (!tip) return;
    const layer = layerRef.current;
    const el = tipRef.current;
    if (!layer || !el) return;
    const lr = layer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const prev = shiftRef.current;
    // 还原成"未修正"的矩形再算：渲染出来的是 未修正 + prevShift，
    // 所以这里减回去，得到的修正量是绝对值（不会把上一轮的修正叠加两次）。
    const left = r.left - prev.dx;
    const right = r.right - prev.dx;
    const top = r.top - prev.dy;
    const bottom = r.bottom - prev.dy;
    let dx = 0;
    let dy = 0;
    if (left < lr.left + EDGE_PAD) dx = lr.left + EDGE_PAD - left;
    else if (right > lr.right - EDGE_PAD) dx = lr.right - EDGE_PAD - right;
    if (top < lr.top + EDGE_PAD) dy = lr.top + EDGE_PAD - top;
    else if (bottom > lr.bottom - EDGE_PAD) dy = lr.bottom - EDGE_PAD - bottom;
    if (dx !== prev.dx || dy !== prev.dy) {
      shiftRef.current = { dx, dy };
      setShift({ dx, dy });
    }
  }, [tip]);

  return (
    <div
      ref={layerRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 50,
        overflow: "hidden",
      }}
    >
      {tip && (
        <div
          ref={tipRef}
          style={{
            position: "absolute",
            left: tip.x + tip.w / 2,
            top: tip.pos === "bottom" ? tip.y + tip.h + 6 : tip.y - 6,
            transform: `translate(calc(-50% + ${shift.dx}px), calc(${
              tip.pos === "bottom" ? "0%" : "-100%"
            } + ${shift.dy}px))`,
            maxWidth: 240,
            padding: "4px 9px",
            borderRadius: 8,
            // 与年月下拉同一套"浮层"材质：深色主题深灰、浅色主题近白（否则浅色主题下
            // 会掉下一块深色气泡）
            background: "var(--popover-bg)",
            border: "1px solid var(--island-border)",
            boxShadow: "var(--popover-shadow)",
            color: "var(--island-text)",
            fontSize: 10.5,
            lineHeight: 1.35,
            letterSpacing: 0.2,
            whiteSpace: tip.label.length > 16 ? "normal" : "nowrap",
            animation: "tipIn 120ms ease-out",
          }}
        >
          {tip.label}
        </div>
      )}
    </div>
  );
}
