/**
 * iCalendar (.ics) 导入解析。
 *
 * 手写而不是引库：只解析本应用真正消费的字段（见下），
 * 第三方库会连带整套 VTIMEZONE / RRULE 语义与体积，而本站只需要
 * 「日期 + 时间 + 重复 + 单次改动」这四件事。
 *
 * 支持：
 * - 折行（RFC 5545 §3.1，续行以空格/Tab 开头）、CRLF/LF、BOM
 * - VEVENT：UID / SUMMARY / DTSTART / DTEND / DURATION / LOCATION /
 *   DESCRIPTION / STATUS / RRULE / EXDATE / RECURRENCE-ID
 * - 日期形态：VALUE=DATE（全天）、本地时间、UTC（后缀 Z）
 * - RRULE：FREQ(DAILY/WEEKLY/MONTHLY/YEARLY) / INTERVAL / COUNT / UNTIL /
 *   BYDAY / BYMONTHDAY
 * - EXDATE → action:"cancel"，RECURRENCE-ID → action:"override"
 * - VALARM / VTIMEZONE 等子块一律跳过
 *
 * 不支持（明确降级并记 warning，不静默丢数据）：
 * - HOURLY/MINUTELY/SECONDLY 频率 → 退化为单次事件
 * - BYDAY 序数（如「每月第 2 个周二」）、BYMONTHDAY 负数、BYSETPOS
 * - VTIMEZONE 偏移 → 一律按本地时间理解
 */

import type { CalendarEvent, EventException, EventPatch, Recurrence } from "../types/schedule";
import { DEFAULT_REMINDER_MINUTES } from "../types/schedule";
import { pruneExceptions, toLocalDateKey, toLocalIso } from "../utils/recurrence";

export interface IcsParseStats {
  /** 文件里的 VEVENT 总数（含被跳过的） */
  vevents: number;
  /** 最终产生的事件条数 */
  imported: number;
  /** STATUS:CANCELLED 被整条丢弃的条数 */
  cancelled: number;
  /** 缺 DTSTART 等无法解析而跳过的条数 */
  skipped: number;
}

export interface IcsParseResult {
  events: CalendarEvent[];
  warnings: string[];
  stats: IcsParseStats;
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
  line: number;
}

// ---------------------------------------------------------------- 文本层

/** 展开折行：把以空格/Tab 开头的续行拼回上一行 */
function unfold(raw: string): Array<{ text: string; line: number }> {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const out: Array<{ text: string; line: number }> = [];
  let buffer = "";
  let startLine = 0;

  text.split("\n").forEach((line, index) => {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // 续行：去掉前导一个空白字符后直接拼接
      buffer += line.slice(1);
      return;
    }
    if (buffer) out.push({ text: buffer, line: startLine });
    buffer = line;
    startLine = index + 1;
  });
  if (buffer) out.push({ text: buffer, line: startLine });
  return out;
}

/** 反转义文本值：\n \, \; \\ */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === "n" || next === "N") out += "\n";
    else if (next === ",") out += ",";
    else if (next === ";") out += ";";
    else if (next === "\\") out += "\\";
    else if (next === undefined) out += "\\";
    else out += next;
  }
  return out;
}

/** 找到第一个不在引号内的分隔符位置 */
function indexOfUnquoted(text: string, target: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === target) return i;
  }
  return -1;
}

function splitUnquoted(text: string, sep: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const idx = indexOfUnquoted(rest, sep);
    if (idx < 0) {
      parts.push(rest);
      return parts;
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
}

function parseProperty(raw: string, line: number): IcsProperty | null {
  const colon = indexOfUnquoted(raw, ":");
  if (colon < 0) return null;
  const left = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const segments = splitUnquoted(left, ";");
  const name = (segments[0] ?? "").trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    let val = segment.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key) params[key] = val;
  }
  return { name, params, value, line };
}

// ---------------------------------------------------------------- 日期层

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

interface ParsedDate {
  date: Date;
  allDay: boolean;
}

/** 解析 DTSTART/DTEND/EXDATE 的日期值 */
function parseIcsDate(
  prop: IcsProperty,
  warnings: string[],
  tzReported: Set<string>
): ParsedDate | null {
  const raw = prop.value.trim();
  const allDayFlag = (prop.params.VALUE ?? "").toUpperCase() === "DATE";
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);

  const tzid = prop.params.TZID;
  if (tzid && !tzReported.has(tzid)) {
    tzReported.add(tzid);
    warnings.push(`时区 ${tzid} 未做换算，一律按本地时间理解（第 ${prop.line} 行）`);
  }

  if (allDayFlag || dateOnly) {
    const m = dateOnly ?? dateTime;
    if (!m) return null;
    const [, y, mo, d] = m;
    return {
      date: new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0),
      allDay: true,
    };
  }

  if (!dateTime) return null;
  const [, y, mo, d, hh, mm, ss, z] = dateTime;
  if (z) {
    // UTC：先按 UTC 造时间，再取本地分量，得到本地壁钟时间
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return { date: new Date(utc), allDay: false };
  }
  return {
    date: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), 0),
    allDay: false,
  };
}

/** 解析 DURATION（P1D / PT1H30M / P2W） */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase()
  );
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  if (!w && !d && !h && !min && !s) return null;
  const ms =
    (Number(w ?? 0) * 7 * 24 + Number(d ?? 0) * 24) * 3_600_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(min ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

// ---------------------------------------------------------------- 重复层

function parseRRule(value: string, prop: IcsProperty, warnings: string[]): Recurrence | null {
  const parts = splitUnquoted(value.trim().toUpperCase(), ";");
  const rules: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    rules[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }

  const freqMap: Record<string, Recurrence["freq"]> = {
    DAILY: "DAILY",
    WEEKLY: "WEEKLY",
    MONTHLY: "MONTHLY",
    YEARLY: "YEARLY",
  };
  const freq = freqMap[rules.FREQ ?? ""];
  if (!freq) {
    warnings.push(`不支持的重复频率 FREQ=${rules.FREQ ?? "?"}，已退化为单次事件（第 ${prop.line} 行）`);
    return null;
  }

  const rule: Recurrence = { freq, interval: Math.max(1, Number(rules.INTERVAL ?? 1) || 1) };

  if (rules.COUNT) {
    const count = Number(rules.COUNT);
    if (Number.isFinite(count) && count > 0) rule.count = Math.floor(count);
  }

  if (rules.UNTIL) {
    // UNTIL 可能是 20261130T235959Z 或 20261130
    const untilRaw = /^(\d{4})(\d{2})(\d{2})/.exec(rules.UNTIL);
    if (untilRaw) {
      const [, y, mo, d] = untilRaw;
      if (rules.UNTIL.endsWith("Z")) {
        const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), 23, 59, 59);
        rule.until = toLocalDateKey(new Date(utc));
      } else {
        rule.until = `${y}-${mo}-${d}`;
      }
    }
  }

  if (rules.BYDAY) {
    const tokens = rules.BYDAY.split(",").map((t) => t.trim()).filter(Boolean);
    const weekdays: number[] = [];
    let sawOrdinal = false;
    for (const token of tokens) {
      // 形如 MO / 2TU / -1SU：序号部分对 WEEKLY 无意义，对 MONTHLY 不支持
      const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
      if (!match) continue;
      if (match[1]) sawOrdinal = true;
      const index = WEEKDAY_INDEX[match[2]];
      if (index !== undefined) weekdays.push(index);
    }
    if (sawOrdinal) {
      warnings.push(`BYDAY 序数（第 N 个周 X）不支持，已按「每个周 X」处理（第 ${prop.line} 行）`);
    }
    if (weekdays.length) rule.byWeekday = [...new Set(weekdays)].sort((a, b) => a - b);
  }

  if (rules.BYMONTHDAY) {
    const days = rules.BYMONTHDAY.split(",")
      .map((t) => Number(t.trim()))
      .filter((n) => Number.isFinite(n));
    const negative = days.filter((n) => n < 0);
    if (negative.length) {
      warnings.push(`BYMONTHDAY 负数（倒数第 N 天）不支持，已忽略 ${negative.join(", ")}（第 ${prop.line} 行）`);
    }
    const positive = days.filter((n) => n >= 1 && n <= 31);
    if (positive.length) rule.byMonthDay = [...new Set(positive)].sort((a, b) => a - b);
  }

  if (rules.BYSETPOS) {
    warnings.push(`BYSETPOS 不支持，已忽略（第 ${prop.line} 行）`);
  }

  return rule;
}

// ---------------------------------------------------------------- 主流程

/** 内容指纹，用于缺少 UID 的事件做稳定键，保证重复导入是更新而不是新增 */
function fingerprint(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function firstProp(props: IcsProperty[], name: string): IcsProperty | undefined {
  return props.find((p) => p.name === name);
}

function allProps(props: IcsProperty[], name: string): IcsProperty[] {
  return props.filter((p) => p.name === name);
}

/** 收集文件里所有顶层 VEVENT（跳过 VALARM / VTODO / VTIMEZONE 等子块） */
function collectVevents(raw: string): Array<{ props: IcsProperty[]; line: number }> {
  const blocks: Array<{ props: IcsProperty[]; line: number }> = [];
  let current: IcsProperty[] | null = null;
  let startLine = 0;
  let depth = 0;

  for (const { text, line } of unfold(raw)) {
    const upper = text.trim().toUpperCase();

    if (upper === "BEGIN:VEVENT") {
      current = [];
      startLine = line;
      depth = 0;
      continue;
    }
    if (upper === "END:VEVENT") {
      if (current) blocks.push({ props: current, line: startLine });
      current = null;
      continue;
    }
    if (!current) continue;

    if (upper.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (upper.startsWith("END:")) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue; // VALARM 等子块内的属性一律忽略

    const prop = parseProperty(text, line);
    if (prop) current.push(prop);
  }
  return blocks;
}

/**
 * 解析 .ics 文本为事件数组。
 *
 * 重复系列的 RECURRENCE-ID 实例会合并进主事件的 exceptions，
 * 与 src/utils/recurrence.ts 的语义严格一致（cancel = EXDATE，
 * override = 覆盖字段）。
 */
export function parseIcs(raw: string, now: Date = new Date()): IcsParseResult {
  const warnings: string[] = [];
  const tzReported = new Set<string>();
  const stats: IcsParseStats = { vevents: 0, imported: 0, cancelled: 0, skipped: 0 };
  const blocks = collectVevents(raw);
  stats.vevents = blocks.length;

  if (!blocks.length) {
    warnings.push("文件里没有找到任何 VEVENT 事件");
    return { events: [], warnings, stats };
  }

  const stamp = toLocalIso(now);

  interface Draft {
    uid?: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    location?: string;
    notes?: string;
    recurrence: Recurrence | null;
    cancels: string[];
    overrides: Array<{ occurrenceDate: string; patch: EventPatch }>;
    order: number;
  }

  const masters = new Map<string, Draft>();
  /** RECURRENCE-ID 实例先暂存，等主事件建好后再合并 */
  const instances: Array<{ uid: string; occurrenceDate: string; patch: EventPatch; cancelled: boolean; title?: string }> = [];

  blocks.forEach((block, index) => {
    const props = block.props;

    const status = (firstProp(props, "STATUS")?.value ?? "").trim().toUpperCase();
    const recurrenceId = firstProp(props, "RECURRENCE-ID");
    const uidProp = firstProp(props, "UID");
    const uid = uidProp?.value.trim() || undefined;

    const dtstart = firstProp(props, "DTSTART");
    if (!dtstart) {
      stats.skipped++;
      warnings.push(`第 ${block.line} 行的 VEVENT 缺少 DTSTART，已跳过`);
      return;
    }

    const startParsed = parseIcsDate(dtstart, warnings, tzReported);
    if (!startParsed) {
      stats.skipped++;
      warnings.push(`第 ${block.line} 行的 DTSTART 无法解析（${dtstart.value}），已跳过`);
      return;
    }

    const summary = firstProp(props, "SUMMARY");
    const location = firstProp(props, "LOCATION");
    const description = firstProp(props, "DESCRIPTION");

    // 结束时间：优先 DTEND，其次 DURATION，最后按全天/单点处理
    const dtend = firstProp(props, "DTEND");
    const durationProp = firstProp(props, "DURATION");
    let endParsed: ParsedDate | null = null;
    if (dtend) {
      endParsed = parseIcsDate(dtend, warnings, tzReported);
      if (endParsed && startParsed.allDay && endParsed.allDay) {
        // RFC 5545：全天的 DTEND 是「次日零点」（右开区间），转成当天
        endParsed = {
          date: new Date(endParsed.date.getTime() - 86_400_000),
          allDay: true,
        };
        if (endParsed.date.getTime() < startParsed.date.getTime()) endParsed = null;
      }
    } else if (durationProp) {
      const duration = parseDuration(durationProp.value);
      if (duration !== null && duration > 0) {
        endParsed = { date: new Date(startParsed.date.getTime() + duration), allDay: startParsed.allDay };
      }
    }

    const startIso = startParsed.allDay
      ? `${toLocalDateKey(startParsed.date)}T00:00`
      : toLocalIso(startParsed.date);
    const endIso = endParsed
      ? endParsed.allDay
        ? `${toLocalDateKey(endParsed.date)}T00:00`
        : toLocalIso(endParsed.date)
      : startIso;

    const title = summary ? unescapeText(summary.value).trim() || "未命名日程" : "未命名日程";

    // RECURRENCE-ID 实例：不新建事件，作为主事件的一次改动
    if (recurrenceId && uid) {
      const recParsed = parseIcsDate(recurrenceId, warnings, tzReported);
      if (!recParsed) {
        stats.skipped++;
        warnings.push(`第 ${block.line} 行的 RECURRENCE-ID 无法解析，已跳过`);
        return;
      }
      const occurrenceDate = toLocalDateKey(recParsed.date);
      const patch: EventPatch = {};
      if (summary) patch.title = title;
      if (location) patch.location = unescapeText(location.value).trim();
      if (description) patch.notes = unescapeText(description.value).trim();
      instances.push({
        uid,
        occurrenceDate,
        patch,
        cancelled: status === "CANCELLED",
        title,
      });
      // start/end 在合并阶段与「系列应得的时间」比较后再决定是否写进 patch
      instances[instances.length - 1].patch.start = startIso;
      instances[instances.length - 1].patch.end = endIso;
      instances[instances.length - 1].patch.allDay = startParsed.allDay;
      return;
    }

    // 整条取消的普通事件：直接丢弃
    if (status === "CANCELLED" && !recurrenceId) {
      stats.cancelled++;
      return;
    }

    const rruleProp = firstProp(props, "RRULE");
    const recurrence = rruleProp ? parseRRule(rruleProp.value, rruleProp, warnings) : null;

    const cancels: string[] = [];
    for (const exdate of allProps(props, "EXDATE")) {
      for (const piece of splitUnquoted(exdate.value, ",")) {
        const pseudo: IcsProperty = { ...exdate, value: piece };
        const parsed = parseIcsDate(pseudo, warnings, tzReported);
        if (parsed) cancels.push(toLocalDateKey(parsed.date));
      }
    }

    const effectiveUid = uid ?? `no-uid-${fingerprint(`${title}|${startIso}`)}`;
    if (!uid) {
      warnings.push(`第 ${block.line} 行的 VEVENT 缺少 UID，已按内容生成稳定键（重复导入会更新而非新增）`);
    }

    masters.set(effectiveUid, {
      uid: effectiveUid,
      title,
      start: startIso,
      end: endIso,
      allDay: startParsed.allDay,
      location: location ? unescapeText(location.value).trim() : undefined,
      notes: description ? unescapeText(description.value).trim() : undefined,
      recurrence,
      cancels,
      overrides: [],
      order: index,
    });
  });

  // 合并 RECURRENCE-ID 实例
  for (const instance of instances) {
    const master = masters.get(instance.uid);
    if (!master) {
      // 主事件可能不在同一文件里（如「仅导出这一次」）→ 退化为独立单次事件
      stats.skipped++;
      warnings.push(
        `RECURRENCE-ID 实例找不到同 UID 的主事件（${instance.uid}），已跳过这一次改动`
      );
      continue;
    }
    if (instance.cancelled) {
      master.cancels.push(instance.occurrenceDate);
      continue;
    }

    // 与「系列按规则应得的时间」比较：一致就不写 patch，避免无意义的 overridden
    const baseStart = master.start;
    const expectedStart = master.allDay
      ? `${instance.occurrenceDate}T00:00`
      : `${instance.occurrenceDate}T${baseStart.slice(11, 16)}`;
    const patch: EventPatch = { ...instance.patch };
    if (patch.start === expectedStart) delete patch.start;
    if (patch.title === master.title) delete patch.title;
    if (patch.location === (master.location ?? "")) delete patch.location;
    if (patch.notes === (master.notes ?? "")) delete patch.notes;
    if (patch.allDay === master.allDay) delete patch.allDay;
    master.overrides.push({ occurrenceDate: instance.occurrenceDate, patch });
  }

  // 落成 CalendarEvent
  const events: CalendarEvent[] = [];
  for (const draft of masters.values()) {
    const exceptions: EventException[] = [
      ...[...new Set(draft.cancels)].map(
        (occurrenceDate): EventException => ({ occurrenceDate, action: "cancel" })
      ),
      ...draft.overrides
        .filter((item) => Object.keys(item.patch).length > 0)
        .map(
          (item): EventException => ({
            occurrenceDate: item.occurrenceDate,
            action: "override",
            patch: item.patch,
          })
        ),
    ];

    const base: CalendarEvent = {
      id: `ics-${fingerprint(draft.uid ?? draft.start)}`,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      allDay: draft.allDay,
      location: draft.location,
      notes: draft.notes,
      reminderMinutes: DEFAULT_REMINDER_MINUTES,
      alarmEnabled: false,
      source: "ics",
      uid: draft.uid,
      recurrence: draft.recurrence,
      exceptions: [],
      createdAt: stamp,
      updatedAt: stamp,
    };

    events.push({
      ...base,
      exceptions: draft.recurrence ? pruneExceptions(base, exceptions) : [],
    });
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  stats.imported = events.length;
  return { events, warnings, stats };
}
