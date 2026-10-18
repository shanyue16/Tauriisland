/**
 * 日程数据层（唯一权威）。
 *
 * - 持久化：tauri-plugin-store 的 schedule.json，键 "events"，200ms 去抖落盘。
 * - 读写全部经过这里；将来换 SQLite 只替换本文件，UI 不用动。
 * - 展开/单次改动的语义在 src/utils/recurrence.ts，本文件只负责存。
 */

import { create } from "zustand";
import { createDiskChannel } from "./disk";
import type {
  CalendarEvent,
  EventDraft,
  EventPatch,
  Occurrence,
  Recurrence,
} from "../types/schedule";
import { DEFAULT_REMINDER_MINUTES } from "../types/schedule";
import {
  endOfDay,
  expandEvent,
  startOfDay,
  toLocalDateKey,
  toLocalIso,
  withException,
  withoutException,
} from "../utils/recurrence";

const STORE_FILE = "schedule.json";
const STORE_KEY = "events";

const disk = createDiskChannel<CalendarEvent[]>(STORE_FILE, STORE_KEY);

function persist(events: CalendarEvent[]) {
  disk.write(events);
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeEvent(raw: Partial<CalendarEvent>): CalendarEvent | null {
  if (!raw || typeof raw.start !== "string" || typeof raw.end !== "string") return null;
  const now = toLocalIso(new Date());
  return {
    id: raw.id ?? genId(),
    title: raw.title?.trim() || "未命名日程",
    start: raw.start,
    end: raw.end,
    allDay: Boolean(raw.allDay),
    location: raw.location,
    notes: raw.notes,
    reminderMinutes:
      raw.reminderMinutes === undefined ? DEFAULT_REMINDER_MINUTES : raw.reminderMinutes,
    alarmEnabled: raw.alarmEnabled ?? false,
    source: raw.source === "ics" ? "ics" : "manual",
    uid: raw.uid,
    recurrence: raw.recurrence ?? null,
    exceptions: Array.isArray(raw.exceptions) ? raw.exceptions : [],
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}

export interface ScheduleStore {
  events: CalendarEvent[];
  loaded: boolean;
  load: () => Promise<void>;

  createEvent: (draft: EventDraft) => CalendarEvent;
  /**
   * 整条事件改动。「整个系列」保存走这里（允许同时改 recurrence）；
   * 「仅本次」走 overrideOccurrence，不要用这个 —— 那会改掉整个系列。
   */
  updateEvent: (id: string, patch: EventPatch & { recurrence?: Recurrence | null }) => void;
  removeEvent: (id: string) => void;

  /** 只改这一次（写 override exception） */
  overrideOccurrence: (id: string, occurrenceDate: string, patch: EventPatch) => void;
  /** 取消这一次（写 cancel exception，等价 EXDATE） */
  cancelOccurrence: (id: string, occurrenceDate: string) => void;
  /** 恢复为系列默认（删掉 exception） */
  resetOccurrence: (id: string, occurrenceDate: string) => void;

  /** 导入 upsert：uid 命中则更新，否则新增 */
  upsertImported: (incoming: CalendarEvent[]) => { added: number; updated: number };

  occurrencesInRange: (from: Date, to: Date) => Occurrence[];
  eventsOnDate: (date: Date) => Occurrence[];
  nextReminders: (now: Date, horizonMinutes: number) => Occurrence[];
}

function mapEvents(
  events: CalendarEvent[],
  id: string,
  fn: (event: CalendarEvent) => CalendarEvent
): CalendarEvent[] {
  let changed = false;
  const next = events.map((event) => {
    if (event.id !== id) return event;
    changed = true;
    const updated = fn(event);
    return { ...updated, updatedAt: toLocalIso(new Date()) };
  });
  return changed ? next : events;
}

export const useScheduleStore = create<ScheduleStore>((set, get) => ({
  events: [],
  loaded: false,

  load: async () => {
    try {
      const stored = ((await disk.read()) as Partial<CalendarEvent>[] | null) ?? [];
      const events = stored
        .map(normalizeEvent)
        .filter((item): item is CalendarEvent => item !== null);
      set({ events, loaded: true });
    } catch {
      set({ events: [], loaded: true });
    }
  },

  createEvent: (draft) => {
    const now = toLocalIso(new Date());
    const event: CalendarEvent = {
      ...draft,
      id: genId(),
      createdAt: now,
      updatedAt: now,
    };
    const events = [...get().events, event];
    set({ events });
    persist(events);
    return event;
  },

  updateEvent: (id, patch) => {
    const events = mapEvents(get().events, id, (event) => ({ ...event, ...patch }));
    set({ events });
    persist(events);
  },

  removeEvent: (id) => {
    const events = get().events.filter((event) => event.id !== id);
    set({ events });
    persist(events);
  },

  overrideOccurrence: (id, occurrenceDate, patch) => {
    const events = mapEvents(get().events, id, (event) =>
      withException(event, { occurrenceDate, action: "override", patch })
    );
    set({ events });
    persist(events);
  },

  cancelOccurrence: (id, occurrenceDate) => {
    const events = mapEvents(get().events, id, (event) =>
      withException(event, { occurrenceDate, action: "cancel" })
    );
    set({ events });
    persist(events);
  },

  resetOccurrence: (id, occurrenceDate) => {
    const events = mapEvents(get().events, id, (event) =>
      withoutException(event, occurrenceDate)
    );
    set({ events });
    persist(events);
  },

  upsertImported: (incoming) => {
    const byUid = new Map<string, CalendarEvent>();
    for (const event of get().events) {
      if (event.uid) byUid.set(event.uid, event);
    }
    let added = 0;
    let updated = 0;
    const next = [...get().events];
    for (const raw of incoming) {
      const normalized = normalizeEvent(raw);
      if (!normalized) continue;
      const existingIndex = normalized.uid ? next.findIndex((e) => e.uid === normalized.uid) : -1;
      if (existingIndex >= 0) {
        next[existingIndex] = {
          ...next[existingIndex],
          ...normalized,
          id: next[existingIndex].id,
          createdAt: next[existingIndex].createdAt,
        };
        updated++;
      } else {
        next.push(normalized);
        added++;
      }
    }
    set({ events: next });
    persist(next);
    return { added, updated };
  },

  occurrencesInRange: (from, to) => {
    const result: Occurrence[] = [];
    for (const event of get().events) {
      result.push(...expandEvent(event, from, to));
    }
    return result.sort((a, b) => a.start.getTime() - b.start.getTime());
  },

  eventsOnDate: (date) => get().occurrencesInRange(startOfDay(date), endOfDay(date)),

  /** 提醒调度用：now 之后 horizonMinutes 内要触发的 occurrence */
  nextReminders: (now, horizonMinutes) => {
    const horizon = new Date(now.getTime() + horizonMinutes * 60_000);
    return get()
      .occurrencesInRange(startOfDay(now), horizon)
      .filter((occ) => {
        if (occ.event.reminderMinutes === null) return false;
        const fireAt = occ.start.getTime() - occ.event.reminderMinutes * 60_000;
        return fireAt >= now.getTime() && fireAt <= horizon.getTime();
      });
  },
}));

/** 日历月历用：某个日期键上有没有事件（圆点） */
export function hasEventsOnDate(events: CalendarEvent[], dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  return events.some((event) => expandEvent(event, startOfDay(day), endOfDay(day)).length > 0);
}

export { toLocalDateKey };
