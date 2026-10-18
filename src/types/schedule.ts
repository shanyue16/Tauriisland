/**
 * 日程事件数据模型。
 *
 * 存储走 tauri-plugin-store 的 schedule.json（见 src/stores/schedule.ts），
 * 数据层独立，将来迁 SQLite 只换 store 一个文件。
 *
 * 重复规则只覆盖真实日历导出里约九成的形态：
 * DAILY / WEEKLY / MONTHLY / YEARLY + INTERVAL + COUNT/UNTIL + BYDAY。
 * 「仅此次」改动用 exceptions 表达（iCalendar 的 EXDATE / RECURRENCE-ID 语义），
 * 不改动整个系列。
 */

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface Recurrence {
  freq: RecurrenceFreq;
  /** 间隔倍数，1 = 每天 / 每周 / 每月 */
  interval: number;
  /** WEEKLY 用：0 = 周日 .. 6 = 周六；为空则沿用 start 当天 */
  byWeekday?: number[];
  /** MONTHLY 用：1..31；为空则沿用 start 的日 */
  byMonthDay?: number[];
  /** 截止日期（含），本地 "YYYY-MM-DD" */
  until?: string;
  /** 或总次数（含首次） */
  count?: number;
}

export type ExceptionAction = "cancel" | "override";

/** 单次改动：挂在系列事件上，按 occurrenceDate 命中某一次 */
export interface EventException {
  /** 被改动的那一次在原系列里的日期，本地 "YYYY-MM-DD" */
  occurrenceDate: string;
  action: ExceptionAction;
  /** action = "override" 时覆盖的字段；未出现的字段继续跟随系列 */
  patch?: EventPatch;
}

/** 可单次覆盖的字段（不含 id / recurrence / exceptions / createdAt） */
export type EventPatch = Partial<
  Pick<
    CalendarEvent,
    | "title"
    | "start"
    | "end"
    | "allDay"
    | "location"
    | "notes"
    | "reminderMinutes"
    | "alarmEnabled"
  >
>;

export type EventSource = "manual" | "ics";

export interface CalendarEvent {
  id: string;
  title: string;
  /** 本地 ISO，无 Z："YYYY-MM-DDTHH:mm"；全天事件用 "YYYY-MM-DDT00:00" */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  /** 提前多少分钟提醒；null = 不提醒 */
  reminderMinutes: number | null;
  /** 是否响铃。提醒通知永远发，这个字段只管出不出声 */
  alarmEnabled: boolean;
  /** manual = 本地新建，ics = 导入 */
  source: EventSource;
  /** ICS 幂等键：同一 uid 重复导入只更新、不新增 */
  uid?: string;
  /** 重复规则；null/undefined = 单次事件 */
  recurrence?: Recurrence | null;
  /** 单次改动（取消 / 覆盖） */
  exceptions?: EventException[];
  createdAt: string;
  updatedAt: string;
}

export interface Occurrence {
  event: CalendarEvent;
  start: Date;
  end: Date;
  /** 该次在系列中的原始日期 "YYYY-MM-DD"，单次改动的定位键 */
  occurrenceDate: string;
  /** true = 被 exceptions 覆盖过（字段/时间可能已不同） */
  overridden: boolean;
  /** true = 该次被取消（列表里不出现，月历上打「停」标） */
  cancelled?: boolean;
}

/** 新建事件时前端提供的字段 */
export type EventDraft = Omit<CalendarEvent, "id" | "createdAt" | "updatedAt">;

export const DEFAULT_REMINDER_MINUTES = 10;

export const REMINDER_PRESETS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "不提醒" },
  { value: 0, label: "准时" },
  { value: 5, label: "提前 5 分钟" },
  { value: 10, label: "提前 10 分钟" },
  { value: 30, label: "提前 30 分钟" },
];
