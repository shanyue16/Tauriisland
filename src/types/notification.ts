/**
 * 系统通知的数据模型 —— 与 Rust 侧 `notifications::NotificationItem` 字段一一对应。
 */

export interface NotificationItem {
  /** `Notification.Id` */
  id: number;
  /** `NotificationHandler.PrimaryId` 原文（包标识 / 文件路径 / 含 `!` 的复合串） */
  appId: string;
  /** Rust 侧推导出的显示名（取不到时等于 appId） */
  appName: string;
  /** 第 1 个非空 `<text>` */
  title: string;
  /** 其余 `<text>` 用 `\n` 连接（可能为空串） */
  body: string;
  /** Unix 秒 */
  createdAt: number;
  /** "toast" */
  kind: string;
}

/** Rust 侧 serde 用 snake_case，这里做一次映射，避免上层到处写 snake_case */
export interface RawNotificationItem {
  id: number;
  app_id: string;
  app_name: string;
  title: string;
  body: string;
  created_at: number;
  kind: string;
}

export function fromRaw(raw: RawNotificationItem): NotificationItem {
  return {
    id: raw.id,
    appId: raw.app_id ?? "",
    appName: raw.app_name || raw.app_id || "未知应用",
    title: raw.title ?? "",
    body: raw.body ?? "",
    createdAt: raw.created_at ?? 0,
    kind: raw.kind ?? "toast",
  };
}

/**
 * 黑名单匹配 —— 忽略大小写 + 子串匹配（与音乐白名单同口径）。
 *
 * 匹配 `appId`（写入黑名单的值）**或** `appName`（用户看到的显示名）任一命中即屏蔽。
 * 理由：用户点"不再显示该应用"时写入的是 appId，但他在设置页里可能想手输
 * "QQ" 这种显示名；两个都认最符合直觉，也覆盖"同一应用换了上报标识"的情况。
 *
 * 黑名单为空 = 不过滤（默认全读，见 docs/notifications-plan.md §3.6）。
 */
export function isBlacklisted(item: NotificationItem, blacklist: string[]): boolean {
  if (blacklist.length === 0) return false;
  const appId = item.appId.toLowerCase();
  const appName = item.appName.toLowerCase();
  return blacklist.some((entry) => {
    const needle = entry.trim().toLowerCase();
    if (!needle) return false;
    return appId.includes(needle) || appName.includes(needle);
  });
}
