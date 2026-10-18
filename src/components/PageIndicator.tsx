import { useI18n } from "../i18n";

interface PageIndicatorProps {
  /** 总页数 */
  count: number;
  /** 当前页（0-based，越界会自动收敛） */
  activeIndex: number;
  /** horizontal = 底部横排（展开态）；vertical = 侧面竖排（悬浮态） */
  orientation?: "horizontal" | "vertical";
  /** 点击圆点跳页（可选） */
  onSelect?: (index: number) => void;
}

/**
 * 页码指示器 —— 全部为圆点，当前页是高亮圆点（尺寸更大 + 更亮 + 微光）。
 * - horizontal：展开态底部
 * - vertical：悬浮态右侧
 * 颜色取自主题变量（--island-text），不新增配色。
 */
export default function PageIndicator({
  count,
  activeIndex,
  orientation = "horizontal",
  onSelect,
}: PageIndicatorProps) {
  const { t } = useI18n();
  const vertical = orientation === "vertical";
  const safeActive = Math.min(Math.max(activeIndex, 0), Math.max(count - 1, 0));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        gap: vertical ? 4 : 5,
      }}
    >
      {Array.from({ length: count }, (_, i) => {
        const active = i === safeActive;
        const size = active ? 7 : 5;

        return (
          <button
            key={i}
            type="button"
            aria-label={t("notification.pageIndicator", { page: i + 1 })}
            aria-current={active ? "page" : undefined}
            data-tip={t("notification.pageIndicator", { page: i + 1 })}
            data-tip-pos={vertical ? "bottom" : "top"}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(i);
            }}
            style={{
              width: size,
              height: size,
              padding: 0,
              border: "none",
              borderRadius: "50%",
              background: "var(--island-text)",
              opacity: active ? 0.95 : 0.25,
              boxShadow: active
                ? "0 0 6px var(--accent-glow), 0 0 1px var(--accent-glow)"
                : "none",
              cursor: onSelect ? "pointer" : "default",
              transition:
                "width 220ms cubic-bezier(0.2,0.8,0.2,1), height 220ms cubic-bezier(0.2,0.8,0.2,1), opacity 180ms ease, box-shadow 180ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = active ? "1" : "0.6";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = active ? "0.95" : "0.25";
            }}
          />
        );
      })}
    </div>
  );
}
