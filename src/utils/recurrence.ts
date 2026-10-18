/**
 * 重复事件展开 + 单次改动（exceptions）的纯函数层。
 *
 * 不依赖任何日期库：事件时间统一用本地 ISO（无 Z），
 * 展开结果以 Date 返回，UI 只读 Occurrence。
 *
 * 语义对齐 iCalendar：
 * - 本系列里每一次 = 一个 occurrence，定位键是它**在原系列里的日期**（occurrenceDate）。
 * - action "cancel" = EXDATE，该次不出现。
 * - action "override" = RECURRENCE-ID + 覆盖字段，未覆盖的字段继续跟系列走。
 * - 孤立 exception（日期已不在系列内）在写入时被清理，不留垃圾。
 */

import type {
  CalendarEvent,
  EventException,
  EventPatch,
  Occurrence,
  Recurrence,
} from "../types/schedule";

const DAY_MS = 86_400_000;
/** 单次展开的硬上限，防止坏数据（如 interval=0）把循环跑死 */
const MAX_OCCURRENCES = 2000;
/** 无 until 时，展开窗口最多往后推 5 年 */
const MAX_SPAN_MS = 5 * 365 * DAY_MS;

export function parseLocal(iso: string): Date {
  const [datePart, timePart = "00:00"] = iso.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
}

export function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toLocalIso(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${toLocalDateKey(date)}T${hh}:${mm}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** 系列里每个 occurrence 的原始开始时间（按真实日期推进，不依赖索引运算） */
function* seriesStarts(event: CalendarEvent, hardStop: Date): Generator<Date> {
  const base = parseLocal(event.start);
  const rule: Recurrence | null | undefined = event.recurrence;
  const interval = Math.max(1, Math.floor(rule?.interval ?? 1));
  const max = Math.max(1, Math.floor(rule?.count ?? MAX_OCCURRENCES));
  const untilMs = rule?.until ? parseLocal(`${rule.until}T23:59`).getTime() : null;

  const within = (start: Date): boolean =>
    (untilMs === null || start.getTime() <= untilMs) &&
    start.getTime() <= hardStop.getTime();

  if (!rule) {
    if (within(base)) yield base;
    return;
  }

  if (rule.freq === "DAILY") {
    for (let i = 0; i < max; i++) {
      const start = addDays(base, i * interval);
      if (!within(start)) return;
      yield start;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const weekdays = (
      rule.byWeekday?.length ? rule.byWeekday : [base.getDay()]
    )
      .filter((d) => d >= 0 && d <= 6)
      .slice()
      .sort((a, b) => a - b);
    const weekStart = addDays(base, -base.getDay());
    let emitted = 0;
    for (let w = 0; emitted < max; w++) {
      const anchor = addDays(weekStart, w * 7 * interval);
      if (anchor.getTime() - 7 * DAY_MS > hardStop.getTime()) return;
      for (const weekday of weekdays) {
        const start = addDays(anchor, weekday);
        if (start.getTime() < base.getTime()) continue;
        if (!within(start)) return;
        emitted++;
        yield start;
        if (emitted >= max) return;
      }
    }
    return;
  }

  // MONTHLY / YEARLY：以 base 的年月为锚，逐月 / 逐年推进
  const monthDays = (
    rule.byMonthDay?.length ? rule.byMonthDay : [base.getDate()]
  )
    .filter((d) => d >= 1 && d <= 31)
    .slice()
    .sort((a, b) => a - b);
  let cursor = new Date(base.getFullYear(), base.getMonth(), 1);
  let emitted = 0;
  while (emitted < max) {
    if (cursor.getTime() - 62 * DAY_MS > hardStop.getTime()) return;
    for (const day of monthDays) {
      const start = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        day,
        base.getHours(),
        base.getMinutes(),
        0,
        0
      );
      // 2 月 30 日这类溢出，JS 会滚到下个月，直接跳过
      if (start.getMonth() !== cursor.getMonth()) continue;
      if (start.getTime() < base.getTime()) continue;
      if (!within(start)) return;
      emitted++;
      yield start;
      if (emitted >= max) return;
    }
    cursor =
      rule.freq === "YEARLY"
        ? new Date(cursor.getFullYear() + interval, cursor.getMonth(), 1)
        : new Date(cursor.getFullYear(), cursor.getMonth() + interval, 1);
  }
}

export function findException(
  event: CalendarEvent,
  occurrenceDate: string
): EventException | undefined {
  return event.exceptions?.find((item) => item.occurrenceDate === occurrenceDate);
}

/** 展开一个事件在 [rangeStart, rangeEnd] 内出现的所有 occurrence，已应用单次改动 */
export function expandEvent(
  event: CalendarEvent,
  rangeStart: Date,
  rangeEnd: Date
): Occurrence[] {
  const baseStart = parseLocal(event.start);
  const baseEnd = parseLocal(event.end);
  const duration = Math.max(0, baseEnd.getTime() - baseStart.getTime());
  const hardStop = new Date(rangeEnd.getTime() + DAY_MS);
  const result: Occurrence[] = [];

  for (const seriesStart of seriesStarts(event, hardStop)) {
    const occurrenceDate = toLocalDateKey(seriesStart);
    const exception = findException(event, occurrenceDate);
    if (exception?.action === "cancel") continue;

    const patch: EventPatch | undefined =
      exception?.action === "override" ? exception.patch : undefined;
    const start = patch?.start ? parseLocal(patch.start) : seriesStart;
    const end = patch?.end
      ? parseLocal(patch.end)
      : new Date(start.getTime() + duration);

    // 单次改动可能把这次挪出窗口，按改动后的时间去重
    if (end.getTime() < rangeStart.getTime() || start.getTime() > rangeEnd.getTime()) {
      continue;
    }

    result.push({
      event,
      start,
      end,
      occurrenceDate,
      overridden: Boolean(patch),
    });
  }

  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** 系列里所有 occurrence 的日期键（用于清理孤立 exception），有界扫描 */
export function seriesDateKeys(event: CalendarEvent): Set<string> {
  const base = parseLocal(event.start);
  const untilMs = event.recurrence?.until
    ? parseLocal(`${event.recurrence.until}T23:59`).getTime()
    : null;
  const hardStop = new Date(
    Math.min(untilMs ?? base.getTime() + MAX_SPAN_MS, base.getTime() + MAX_SPAN_MS)
  );
  const keys = new Set<string>();
  for (const start of seriesStarts(event, hardStop)) {
    keys.add(toLocalDateKey(start));
    if (keys.size >= MAX_OCCURRENCES) break;
  }
  return keys;
}

export function isSeriesOccurrence(event: CalendarEvent, occurrenceDate: string): boolean {
  if (!event.recurrence) return toLocalDateKey(parseLocal(event.start)) === occurrenceDate;
  return seriesDateKeys(event).has(occurrenceDate);
}

/** 写入 exception：同日期覆盖旧的，并清掉已不在系列里的孤立项 */
export function withException(
  event: CalendarEvent,
  exception: EventException
): CalendarEvent {
  const rest = (event.exceptions ?? []).filter(
    (item) => item.occurrenceDate !== exception.occurrenceDate
  );
  const valid = isSeriesOccurrence(event, exception.occurrenceDate);
  const next = valid && exception.action === "override" && !exception.patch
    ? rest
    : [...rest, exception];
  return { ...event, exceptions: pruneExceptions(event, next) };
}

export function pruneExceptions(
  event: CalendarEvent,
  exceptions: EventException[]
): EventException[] {
  const keys = event.recurrence ? seriesDateKeys(event) : null;
  const seen = new Set<string>();
  const kept: EventException[] = [];
  for (const item of exceptions) {
    if (seen.has(item.occurrenceDate)) continue;
    if (keys && !keys.has(item.occurrenceDate)) continue;
    seen.add(item.occurrenceDate);
    kept.push(item);
  }
  return kept.slice(0, 3660);
}

export function withoutException(event: CalendarEvent, occurrenceDate: string): CalendarEvent {
  if (!event.exceptions?.length) return event;
  return {
    ...event,
    exceptions: event.exceptions.filter((item) => item.occurrenceDate !== occurrenceDate),
  };
}

/** 把一次 occurrence 的显示字段（系列默认 + 单次覆盖）合起来，编辑弹窗用 */
export function resolveOccurrence(event: CalendarEvent, occurrenceDate: string) {
  const exception = findException(event, occurrenceDate);
  const patch = exception?.action === "override" ? (exception.patch ?? {}) : {};
  const baseStart = parseLocal(event.start);
  const duration = Math.max(0, parseLocal(event.end).getTime() - baseStart.getTime());
  const start = patch.start ? parseLocal(patch.start) : baseStart;
  return {
    title: patch.title ?? event.title,
    start,
    end: patch.end ? parseLocal(patch.end) : new Date(start.getTime() + duration),
    allDay: patch.allDay ?? event.allDay,
    location: patch.location ?? event.location,
    notes: patch.notes ?? event.notes,
    // 不能用 `??`：`reminderMinutes: null` 是"不提醒"这个合法值，`null ?? 原值` 会把它吞掉
    reminderMinutes:
      patch.reminderMinutes === undefined ? event.reminderMinutes : patch.reminderMinutes,
    alarmEnabled: patch.alarmEnabled ?? event.alarmEnabled,
    overridden: exception?.action === "override",
  };
}
