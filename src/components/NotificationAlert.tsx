import type { Ref } from "react";
import { useI18n } from "../i18n";
import { lineClampStyle } from "../utils/text";
import type { NotificationItem } from "../types/notification";

/**
 * 新通知提醒（岛短暂展开时显示的内容）。
 *
 * 形态由用户确认：**短暂展开岛显示内容**（像灵动岛/系统 toast），停留时长以 5s 为底，
 * 鼠标悬停在提醒上时不自动收起。计时与状态由 Island 管。
 *
 * 高度**不写死**：这一层的高度由 Island 用 ResizeObserver 量出来，再据此设窗口尺寸，
 * 所以短通知得到矮窗口、长通知得到高窗口。改动这里的边距/字号会直接改变提醒窗口高度。
 */

/** 提醒内容区左右内边距 */
const ALERT_PAD_X = 18;
/** 提醒内容区上下内边距 */
const ALERT_PAD_Y = 12;

interface NotificationAlertProps {
  item: NotificationItem;
  /** Island 用来测量内容高度的回调 ref */
  ref?: Ref<HTMLDivElement>;
}

export default function NotificationAlert({ item, ref }: NotificationAlertProps) {
  const { t } = useI18n();
  const muted = "var(--island-text-muted)";

  return (
    <div
      ref={ref}
      className="w-full flex items-start gap-3"
      style={{ padding: `${ALERT_PAD_Y}px ${ALERT_PAD_X}px` }}
    >
      {/* 左侧 accent 竖线：唯一的结构性标记，标示"这是一条新通知" */}
      <div
        className="shrink-0"
        style={{
          width: 2,
          alignSelf: "stretch",
          borderRadius: 2,
          background: "var(--island-accent)",
          opacity: 0.85,
        }}
      />

      <div className="flex-1 min-w-0">
        {/* 应用名 + 时间 */}
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span
            className="text-[10px] truncate"
            style={{ color: muted, letterSpacing: 0.2 }}
          >
            {item.appName}
          </span>
          <span
            className="text-[10px] shrink-0 tabular-nums"
            style={{ color: muted, opacity: 0.7 }}
          >
            {t("common.justNow")}
          </span>
        </div>

        {/* 标题：最多 3 行，超出才截断（短标题不会占满） */}
        <div
          className="text-[13px] leading-[1.3] font-medium"
          style={lineClampStyle(3)}
        >
          {item.title || t("common.noTitle")}
        </div>

        {/* 正文：最多 4 行 */}
        {item.body && (
          <div
            className="text-[11px] leading-[1.4] mt-1"
            style={{
              color: muted,
              ...lineClampStyle(4),
            }}
          >
            {item.body}
          </div>
        )}
      </div>
    </div>
  );
}
