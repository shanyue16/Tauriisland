import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchNotifications } from "../services/notifications";
import { useSettings } from "../stores/settings";
import { isBlacklisted, type NotificationItem } from "../types/notification";

/**
 * 廉价变化探测的间隔。
 *
 * 为什么不直接把这个值当轮询间隔：完整读取要复制约 3.3MB + 打开 sqlite
 * （实测 28–177ms），1.5s 一次太重。所以做成两级：
 *   1) 每 FAST 毫秒调 `check_notifications`（只 stat 文件，微秒级）；
 *   2) 只有它报告"库变了"才真正拉取完整数据。
 * 于是"新消息出现"的可见延迟 ≈ 1.5s，而不是用户设定的刷新间隔。
 */
const FAST_CHECK_MS = 1500;

/**
 * 系统通知轮询 hook。
 *
 * 三条设计约束（见 docs/notifications-plan.md §3.3 / §3.6）：
 * 1. **只在展开态可见时轮询**：Rust 侧每次完整读取都要复制约 3.3MB 的库快照，
 *    三个页面又是同时 mounted 的（Island 用透明度切换），不 gate 住就会一直读盘。
 * 2. **按 id 增量合并**：整体替换会让列表元素全量重挂载，滚动位置被打断。
 * 3. **黑名单在展示层过滤**（不在 Rust 侧）：改黑名单能立即生效，不必等下一轮轮询。
 *
 * 可注入 fetcher 是为了让状态迁移能被测试（默认用真实 service）。
 */
export function useNotifications(options: {
  /** 展开态当前页是否是通知页 */
  visible: boolean;
  /** 可注入的取数函数（默认 fetchNotifications） */
  fetcher?: (limit: number) => Promise<NotificationItem[]>;
  /** 新通知回调（当前无调用方；供将来的"新通知提醒"订阅） */
  onNew?: (items: NotificationItem[]) => void;
}) {
  const { visible, fetcher = fetchNotifications, onNew } = options;
  const { notificationsEnabled, notificationPollMs, notificationMaxItems, notificationBlacklist } =
    useSettings().settings;

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);

  /** 已见过的通知 id，用于识别"这次真新到的"（供 onNew 用） */
  const seenIdsRef = useRef<Set<number>>(new Set());
  /** 防止慢请求返回时覆盖新一轮结果 */
  const inflightRef = useRef(false);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const load = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const batch = await fetcher(notificationMaxItems);
      if (batch.length > 0) {
        const fresh: NotificationItem[] = [];
        setItems((prev) => {
          const byId = new Map(prev.map((it) => [it.id, it]));
          for (const it of batch) {
            if (!seenIdsRef.current.has(it.id)) fresh.push(it);
            byId.set(it.id, it);
            seenIdsRef.current.add(it.id);
          }
          return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
        });
        // 首次加载不算"新通知"（避免一进页面就弹一堆）
        if (fresh.length > 0 && seenIdsRef.current.size > fresh.length) {
          onNewRef.current?.(fresh);
        }
      }
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, [fetcher, notificationMaxItems]);

  // 可见 + 开启时才轮询；切走立即停（依赖变化会清掉定时器）
  useEffect(() => {
    if (!visible || !notificationsEnabled) return;
    let cancelled = false;
    setLoading(true);
    void load();

    // 第一级：高频廉价探测（只 stat）
    const fast = window.setInterval(() => {
      void (async () => {
        if (cancelled || inflightRef.current) return;
        try {
          const res = await invoke<{ changed: boolean }>("check_notifications");
          if (!cancelled && res?.changed) await load();
        } catch {
          /* 探测失败静默忽略，等下一轮 */
        }
      })();
    }, FAST_CHECK_MS);

    // 第二级：用户设定的间隔做一次兜底完整刷新（防止指纹判定漏掉某种变化）
    const slow = window.setInterval(
      () => void load(),
      Math.max(FAST_CHECK_MS * 2, notificationPollMs)
    );

    return () => {
      cancelled = true;
      window.clearInterval(fast);
      window.clearInterval(slow);
    };
  }, [visible, notificationsEnabled, notificationPollMs, load]);

  const visibleItems = items.filter((it) => !isBlacklisted(it, notificationBlacklist));

  return {
    items: visibleItems,
    /** 未过滤的总数（设置页「不再显示该应用」列表要用到） */
    allItems: items,
    loading,
    reload: load,
  };
}

/**
 * 相对时间文案 —— 列表右侧显示。
 *
 * 分档：1 分钟内"刚刚"、1 小时内"N 分钟前"、今天"今天 HH:mm"、
 * 昨天"昨天 HH:mm"、更早"MM-DD HH:mm"。
 */
export function formatRelativeTime(unixSeconds: number, now: number = Date.now()): string {
  if (!unixSeconds) return "";
  const then = unixSeconds * 1000;
  const diff = now - then;

  if (diff < 0) return "刚刚";
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const d = new Date(then);
  const nowD = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, nowD)) return `今天 ${hhmm}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`;

  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${mmdd} ${hhmm}`;
}
