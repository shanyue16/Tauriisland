import { useEffect, useMemo, useRef, useState } from "react";
import { useNotifications, formatRelativeTime } from "../hooks/useNotifications";
import { useSettings } from "../stores/settings";
import type { NotificationItem } from "../types/notification";

/**
 * 通知页 —— 展开态第 3 页，列出系统通知中心的 toast。
 *
 * 数据来自 Rust 侧解析 wpndatabase.db 快照（见 src-tauri/src/notifications.rs）。
 * 读取默认开启，可用设置页的黑名单收窄范围；过滤在 useNotifications 做，
 * 所以改黑名单立即生效（不必等下一轮轮询）。
 *
 * 视觉（Phase D 定稿）：
 * - 顶部一条 header（计数 + 全部清除）用发丝分隔线划出，列表不再是"漂着的一片字"。
 * - 每行左侧一个 **应用色 chip**（取显示名首字 + 由应用名哈希出的固定色相）。
 *   这是本页唯一的"结构性"装饰，作用是给密集列表一个可扫读的锚点：
 *   同一应用永远同一颜色，一眼能分出"这几条是同一个应用"。
 *   不用真实图标 —— 未打包应用取不到，且多数发送方把图标注册在包清单里。
 * - 标题是**焦点**（白色 12px 常规字重），正文次级（muted），时间最小且等宽数字。
 * - 不画卡片、不加分隔线：靠间距与 chip 建立节奏，避免"千篇一律的卡片套装"。
 *
 * 滚动：列表是岛内唯一的滚动区域，而岛根节点的滚轮处理器默认会 preventDefault 并翻页。
 * 这里用**原生 passive** 监听在列表能滚时吞掉滚轮事件（stopPropagation），
 * 于是"列表能滚就滚列表、滚到头才翻页"。注意**不能**在 island 那侧加
 * "落在滚动区就 return" 的守卫（那会让设置面板滚不回展开态，见 utils/scroll.ts 注释）。
 */

/** 由应用名哈希出一个固定色相 —— 同一应用每次都是同一个颜色 */
function appHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return h;
}

/** 应用 chip 底色：低饱和半透明，压得住深色玻璃又不会花 */
function appChipStyle(name: string): React.CSSProperties {
  const hue = appHue(name);
  return {
    width: 17,
    height: 17,
    borderRadius: 5,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    lineHeight: 1,
    fontWeight: 600,
    background: `hsla(${hue}, 42%, 55%, 0.20)`,
    color: `hsl(${hue}, 62%, 76%)`,
    // 极淡内描边，让 chip 在深色底上有边界但不抢眼
    boxShadow: "inset 0 0 0 1px hsla(0, 0%, 100%, 0.07)",
  };
}

interface NotificationPageProps {
  /** 展开态当前页是否是通知页（三页同时 mounted，不 gate 住会一直读盘） */
  visible?: boolean;
}

export default function NotificationPage({ visible = true }: NotificationPageProps) {
  const { settings, updateSettings, setState } = useSettings();
  const { items, allItems, loading } = useNotifications({ visible });

  /** 展开正文的那条通知 id（长消息默认只显示 2 行，需要能看全） */
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  /** 本会话内手动清掉的通知 id（仅隐藏本页显示，不动系统通知中心） */
  const [cleared, setCleared] = useState<Set<number>>(() => new Set());

  const listRef = useRef<HTMLDivElement | null>(null);

  const shown = items.filter((it) => !cleared.has(it.id));

  // 列表两端吞掉滚轮，避免"想滚列表却翻了页"
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dir = e.deltaY > 0 ? 1 : -1;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const canScroll = !(dir > 0 ? atBottom : atTop);
      if (canScroll) {
        // 还能滚：吃掉事件，岛根节点不会再翻页
        e.stopPropagation();
      } else {
        // 已到端：也吃掉，避免"边界抖动"，翻页交给岛根节点（不 stopPropagation）
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [shown.length]);

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── 关闭读取时的空态 ──
  if (!settings.notificationsEnabled) {
    return (
      <EmptyState
        title="通知读取已关闭"
        hint="开启后这里会显示系统通知"
        action={{ label: "去设置", onClick: () => setState("maximal") }}
      />
    );
  }

  // ── 加载中 / 暂无通知 ──
  if (shown.length === 0) {
    return (
      <EmptyState
        title={loading && allItems.length === 0 ? "读取中…" : "暂无通知"}
        hint={
          loading && allItems.length === 0
            ? undefined
            : "若刚收到通知却未显示，请检查专注助手 / 请勿打扰"
        }
      />
    );
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ color: "var(--island-text)" }}>
      {/*
        顶部条：给列表一个明确的"头"，而不是让内容漂在岛里。
        用一条发丝分隔线（复用 --island-border）与列表分开；分隔线是**结构性**的
        （它划出标题栏与内容区），不是为了装饰。
        上下内边距口径 = 线框稿 expand 规格的 14px（原为 11px，比展开态另两页
        ——音乐详情 pt-[14px]、日历页 py-[14px]——各少 3px，切页时标题栏会往上跳）；
        底部 8px 是标题与发丝线之间的距离，比外侧的 14px 紧，让分隔线更贴近文字。
      */}
      <div
        className="flex items-baseline justify-between shrink-0"
        style={{
          padding: "14px 18px 8px",
          borderBottom: "1px solid var(--island-border)",
        }}
      >
        <span
          className="text-[10px] tabular-nums"
          style={{ color: "var(--island-text-muted)", letterSpacing: 0.3 }}
        >
          通知
          <span style={{ opacity: 0.55, marginLeft: 6 }}>{shown.length}</span>
        </span>
        <button
          type="button"
          onClick={() => setCleared(new Set(allItems.map((it) => it.id)))}
          className="text-[10px] cursor-pointer"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            lineHeight: 1,
            color: "var(--island-text-muted)",
            transition: "color 140ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--island-text)")}
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = "var(--island-text-muted)")
          }
        >
          全部清除
        </button>
      </div>

      {/* 列表：靠间距分隔，不加卡片/分隔线；底部留出页码指示器的空间 */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        style={{ padding: "6px 18px 14px", overscrollBehavior: "contain" }}
      >
        {shown.map((item) => (
          <Row
            key={item.id}
            item={item}
            expandedText={expandedIds.has(item.id)}
            onToggleText={() => toggleExpanded(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  item,
  expandedText,
  onToggleText,
}: {
  item: NotificationItem;
  expandedText: boolean;
  onToggleText: () => void;
}) {
  // 判定是否真的被截断：只有截断了才需要"展开"提示
  const hasBody = Boolean(item.body);
  const isLong = `${item.title}${item.body}`.length > 60 || item.body.includes("\n");
  // chip 上的字符：取显示名第一个"可见"字符（跳过空白/标点开头的奇怪名字）
  const chipChar = useMemo(() => {
    const m = item.appName.replace(/^[\s\p{P}]+/u, "");
    return (m[0] ?? "?").toUpperCase();
  }, [item.appName]);

  return (
    <div
      className="flex gap-[9px]"
      style={{ position: "relative", padding: "9px 0 10px" }}
    >
      {/* 应用 chip：密集列表里唯一的扫读锚点（同应用永远同色） */}
      <div style={appChipStyle(item.appName)} aria-hidden>
        {chipChar}
      </div>

      <div className="flex-1 min-w-0">
        {/* 元信息行：应用名 + 相对时间（都压到最小，把视觉权重让给内容） */}
        <div className="flex items-baseline justify-between gap-2 mb-[3px]">
          <span
            className="text-[10px] truncate"
            style={{ color: "var(--island-text-muted)" }}
          >
            {item.appName}
          </span>
          <span
            className="text-[9px] shrink-0 tabular-nums"
            style={{ color: "var(--island-text-muted)", opacity: 0.75 }}
          >
            {formatRelativeTime(item.createdAt)}
          </span>
        </div>

        {/* 标题 + 正文：点击整块切换展开/收起（长消息默认 2 行截断） */}
        <div
          onClick={isLong ? onToggleText : undefined}
          style={{ cursor: isLong ? "pointer" : "default" }}
          data-tip={isLong ? (expandedText ? "点击收起" : "点击展开全文") : undefined}
        >
          {/* 标题是焦点：纯白、常规字重（不用 bold 堆重量，靠对比度建立层级） */}
          <div
            className="text-[12px] leading-[1.35]"
            style={{
              display: expandedText ? "block" : "-webkit-box",
              WebkitLineClamp: expandedText ? undefined : 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word",
            }}
          >
            {item.title || "（无标题）"}
          </div>

          {/* 正文（可能为空 —— 部分通知只有标题） */}
          {hasBody && (
            <div
              className="text-[11px] leading-[1.4] mt-[2px]"
              style={{
                color: "var(--island-text-muted)",
                display: expandedText ? "block" : "-webkit-box",
                WebkitLineClamp: expandedText ? undefined : 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
                whiteSpace: "pre-wrap",
              }}
            >
              {item.body}
            </div>
          )}
        </div>

        {/* 长消息的展开提示：用 accent 是为了让"这里有更多"可被发现 */}
        {isLong && (
          <button
            type="button"
            onClick={onToggleText}
            className="text-[10px] cursor-pointer"
            style={{
              marginTop: 3,
              background: "none",
              border: "none",
              padding: 0,
              lineHeight: 1,
              color: "var(--island-accent)",
              opacity: 0.9,
            }}
          >
            {expandedText ? "收起" : "展开全文"}
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  const muted = "var(--island-text-muted)";
  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-2"
      style={{ color: "var(--island-text)", padding: "0 18px" }}
    >
      <div
        className="flex items-center justify-center rounded-full shrink-0"
        style={{
          width: 40,
          height: 40,
          background: "rgba(255,255,255,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6 }}>
          <path
            d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M13.7 21a2 2 0 0 1-3.4 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="text-[12px] font-medium">{title}</div>
      {hint && (
        <div className="text-[10px] text-center leading-tight" style={{ color: muted }}>
          {hint}
        </div>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="text-[10px] cursor-pointer"
          style={{
            marginTop: 2,
            padding: "5px 12px",
            borderRadius: 999,
            border: "1px solid var(--island-border)",
            background: "rgba(255,255,255,0.06)",
            color: "var(--island-text)",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
