import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "../../stores/settings";
import { THEME_PRESETS } from "../../types";
import { readPortalThemeVars } from "../../utils/portalTheme";

/**
 * 自绘下拉（替代原生 <select>）。
 *
 * 原生 select 展开的列表由 Chromium 自绘，圆角/底色/阴影都控制不了，
 * 在深色玻璃岛里就是一块系统灰白面板。这里照日历页 DropMenu 的样式做浮层：
 * 12px 圆角 + 发丝描边 + 柔和阴影 + 6px 内边距；选中项用主题 accent 高亮。
 * 关闭时机：选中一项 / 点浮层外 / Esc。
 *
 * **浮层挂到 document.body（portal）**：日程编辑器是岛内的 `overflow: hidden` 覆盖层，
 * 之前用 `position: absolute` 会被祖先裁剪 —— 重复/提醒两个下拉一展开就被切掉下半截。
 * 改成 portal + `position: fixed` 后不受任何祖先的 overflow / transform 影响，
 * 并且按触发按钮的 rect 定位、放不下时向上翻、再放不下就限高滚动。
 *
 * 泛型化是因为它不只服务语言选择 —— 凡是「几选一的枚举」都用这一个，
 * 免得每加一个下拉就抄一份浮层（抄两份必然只修一处）。
 */

const GAP = 6;
const EDGE = 8;
/** 下拉列表的期望高度上限（超过就滚动），够放 5~6 项 */
const MAX_PANEL_HEIGHT = 232;

export default function Dropdown<T extends string>({
  value,
  options,
  onChange,
  t,
  ariaLabel,
}: {
  value: T;
  options: { key: T; labelKey: string }[];
  onChange: (v: T) => void;
  t: (key: string) => string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { settings } = useSettings();
  const theme = THEME_PRESETS[settings.theme];

  // portal 浮层要自带主题变量（解析值），不能继承岛根节点上的 inline 变量
  const portalVars = open ? readPortalThemeVars(anchorRef.current) : undefined;

  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  /** 按触发按钮的 rect 算浮层位置：优先向下，空间不足则向上，宽度跟按钮一致 */
  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const below = viewportH - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    // 下方放得下 3 项就向下；否则选空间更大的一侧（两侧都小就贴着小的那侧限高滚动）
    const useBelow = below >= 120 || below >= above;
    const space = useBelow ? below : above;
    const maxHeight = Math.max(48, Math.min(MAX_PANEL_HEIGHT, space));
    const width = Math.min(Math.max(rect.width, 96), viewportW - EDGE * 2);
    const left = Math.min(Math.max(rect.left, EDGE), viewportW - width - EDGE);
    setPos(
      useBelow
        ? {
            left,
            width,
            top: rect.bottom + GAP,
            maxHeight,
          }
        : {
            left,
            width,
            bottom: viewportH - rect.top + GAP,
            maxHeight,
          }
    );
  }, []);

  // 开面板前先量位置，避免首帧闪一下错位
  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // 任何滚动/改窗口大小都重算，避免浮层与按钮脱开
    const onReflow = () => place();
    // keydown 挂 window（捕获阶段）：window 的捕获先于 document 的捕获，
    // 这样 Esc 只关下拉、不会顺手把日程编辑器一起关掉（编辑器也是 document 捕获）
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, place]);

  const panel =
    open && pos
      ? createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            className="ui-popover"
            style={{
              // 把岛的主题变量解析成具体值搬到浮层上：portal 到 body 后拿不到岛的继承，
              // 否则亮色主题下会退回 :root 的深色默认值（黑底）。
              ...(portalVars as React.CSSProperties),
              position: "fixed",
              left: pos.left,
              ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
              width: pos.width,
              maxHeight: pos.maxHeight,
              overflowY: "auto",
              overscrollBehavior: "contain",
              zIndex: 3000,
              padding: 6,
              borderRadius: 12,
              background: "var(--popover-bg)",
              border: "1px solid var(--island-border)",
              boxShadow: "var(--popover-shadow)",
              backdropFilter: "blur(18px)",
              WebkitBackdropFilter: "blur(18px)",
            }}
          >
            {options.map((o) => {
              const active = o.key === value;
              return (
                <button
                  key={o.key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.key);
                    setOpen(false);
                  }}
                  className="flex items-center justify-between w-full px-2 py-1.5 rounded-md text-[11.5px] cursor-pointer"
                  style={{
                    border: "none",
                    background: active ? "rgba(10,132,255,0.22)" : "transparent",
                    color: active ? "var(--island-text)" : "var(--island-text-muted)",
                    fontWeight: active ? 600 : 400,
                    transition: "background-color 140ms ease",
                  }}
                >
                  <span>{t(o.labelKey)}</span>
                  {active && <span style={{ fontSize: 10 }}>✓</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11.5px] outline-none"
        style={{
          background: open ? "var(--sidebar-tab-active)" : "var(--surface-1)",
          border: `1px solid ${theme.border}`,
          color: theme.text,
          cursor: "pointer",
          transition: "background-color 150ms ease, border-color 150ms ease",
        }}
      >
        <span>{t(options.find((o) => o.key === value)?.labelKey ?? "")}</span>
        <span
          style={{
            fontSize: 8,
            color: "var(--island-text-muted)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 160ms ease",
          }}
        >
          ▾
        </span>
      </button>

      {panel}
    </div>
  );
}
