import type { Occurrence } from "../types/schedule";
import { addDays, toLocalDateKey } from "./recurrence";

/**
 * 提醒判定的**纯函数**部分（不碰 store、不碰 Tauri，可在 node 里直接跑）。
 * 调度循环在 `src/services/reminderScheduler.ts`。
 */

/**
 * 迟到补发上限：到点时间在过去 30 分钟内，仍然补一张通知。
 *
 * 为什么不是"只认 ±30 秒"：用户设「准时提醒」时，往往正好在那一分钟才打开岛，
 * 30s 一轮的扫描很容易错过 90 秒的窄窗口，表现就是"设了准时，没通知"。
 * 半小时足够覆盖"我刚坐下想起来看一眼"，又不至于关岛一小时回来弹一堆。
 */
export const CATCH_UP_MS = 30 * 60_000;
/**
 * 超过补发窗口、但**事件还没结束**时，仍然补一发的上限（2 小时）。
 *
 * 为什么需要它：用户常在"已经响过一次"之后再去改提醒/改时间。改完以后新的
 * fireAt 基本都落在过去（提前量变大、或开始时间往前挪），这时按 CATCH_UP 判就是
 * "过期 → 永不响"，表现成"改了通知时间就再也不通知了"。
 *
 * 为什么封顶 2 小时而不是"到事件结束"：否则早上 9 点的全天日程，晚上开岛会把
 * 今天所有进行中的日程一次性刷一遍。
 */
export const OVERDUE_GRACE_MS = 2 * 60 * 60_000;
/** 容许提前多少（定时器抖动） */
export const EARLY_TOLERANCE_MS = 5_000;
/** 一次扫描最多弹几张，避免睡眠唤醒后一口气刷屏；剩下的留到下一轮 */
export const MAX_FIRES_PER_SCAN = 2;
/** 全天事件的固定提醒时刻 */
export const ALL_DAY_REMINDER_HOUR = 9;

/** 这个实例该在什么时刻提醒（返回 null = 不提醒） */
export function reminderAt(occurrence: Occurrence): Date | null {
  const { event, occurrenceDate } = occurrence;
  if (event.reminderMinutes === null) return null;
  if (event.allDay) {
    const [y, m, d] = occurrenceDate.split("-").map(Number);
    return new Date(y, m - 1, d, ALL_DAY_REMINDER_HOUR, 0, 0, 0);
  }
  return new Date(occurrence.start.getTime() - event.reminderMinutes * 60_000);
}

/**
 * 去重键 = 事件 id + 发生日期 + **本次的提醒时刻**。
 *
 * 把提醒时刻算进去是必须的：用户改了提醒设置（不提醒 → 准时、提前 10 → 提前 30）
 * 或改了这一次的时间，`fireAt` 就变了 —— 这条链路应该能重新响；
 * 而同一份设置下重复扫描、effect 重启、StrictMode 双挂载都得只响一次。
 */
export function reminderKey(occurrence: Occurrence): string {
  const at = reminderAt(occurrence);
  return `${occurrence.event.id}|${occurrence.occurrenceDate}|${at ? at.getTime() : "none"}`;
}

/**
 * 实例的"有效结束点"。
 *
 * 全天事件在库里存成 `2026-10-22T00:00 → 2026-10-22T00:00`（duration 0），
 * 直接拿 `occ.end` 判结束会把当天 09:00 的提醒当成"已经结束"。所以全天按当天 23:59:59 算。
 * 零长的普通事件同理退化成"就在那一刻"。
 */
function effectiveEnd(occurrence: Occurrence): Date {
  if (occurrence.event.allDay) {
    const [y, m, d] = occurrence.occurrenceDate.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  return occurrence.end.getTime() > occurrence.start.getTime() ? occurrence.end : occurrence.start;
}

/**
 * 从一批实例里挑出「此刻该响」的，并就地更新去重表 `fired`。
 *
 * 口径（三条，按顺序判）：
 *  1. 事件**已经结束**（now > end）→ 只记账不补发，关岛半天回来不翻旧账；
 *  2. fireAt 还没到（允许 5s 抖动）→ 跳过，下一轮再看；
 *  3. 已经到点且未结束 → 响，但受 2 小时上限约束（`OVERDUE_GRACE_MS`）：
 *     - 过去 30 分钟内（`CATCH_UP_MS`）= 正常迟到补发；
 *     - 30 分钟~2 小时 = 多半是用户刚改了提醒/时间，补一发；
 *     - 超过 2 小时 = 当过期处理，只记账。
 *
 * `reminderMinutes === null` 的实例也记账，省掉每轮重复判断（改设置后 key 会变，仍能响）。
 */
export function collectDue(
  occurrences: Occurrence[],
  fired: Set<string>,
  now: Date = new Date()
): Occurrence[] {
  const due: Occurrence[] = [];
  for (const occ of occurrences) {
    const key = reminderKey(occ);
    if (fired.has(key)) continue;
    const at = reminderAt(occ);
    if (!at) {
      fired.add(key);
      continue;
    }
    const delta = now.getTime() - at.getTime();
    if (delta < -EARLY_TOLERANCE_MS) continue; // 还没到
    const ended = now.getTime() > effectiveEnd(occ).getTime();
    if (ended || delta > OVERDUE_GRACE_MS) {
      fired.add(key); // 已过期（或事件已结束），不补发
      continue;
    }
    if (due.length >= MAX_FIRES_PER_SCAN) break; // 剩下的留给下一轮（30s 后）
    fired.add(key);
    due.push(occ);
  }

  // 去重表只留最近两天，长跑不会无限增长也不会重复触发旧实例
  if (fired.size > 400) {
    const cutoff = toLocalDateKey(addDays(now, -1));
    for (const key of fired) {
      const parts = key.split("|");
      const datePart = parts[1] ?? "";
      if (datePart < cutoff) fired.delete(key);
    }
  }

  return due;
}
