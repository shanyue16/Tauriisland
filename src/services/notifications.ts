import { invoke } from "@tauri-apps/api/core";
import { fromRaw, type RawNotificationItem, type NotificationItem } from "../types/notification";

/**
 * 读取系统通知。
 *
 * 数据源是 Rust 侧解析 `wpndatabase.db` 快照（不是官方 UserNotificationListener ——
 * 未打包应用拿不到该权限，详见 src-tauri/src/notifications.rs 与 docs/notifications-plan.md）。
 *
 * 降级铁律（与 fetchMusic / 日历 API 同策略）：**任何失败都返回空数组，永不抛异常**，
 * 让 UI 显示空态而不是报错刷屏。
 */
export async function fetchNotifications(limit = 20): Promise<NotificationItem[]> {
  try {
    const raw = await invoke<RawNotificationItem[]>("get_notifications", { limit });
    if (!Array.isArray(raw)) return [];
    return raw.map(fromRaw);
  } catch (err) {
    console.error("[notifications] invoke get_notifications failed:", err);
    return [];
  }
}
