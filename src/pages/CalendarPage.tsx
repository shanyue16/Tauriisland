import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetch } from "@tauri-apps/plugin-http";
import { useI18n } from "../i18n";
import { useScheduleStore } from "../stores/schedule";
import type { Occurrence } from "../types/schedule";
import { endOfDay, toLocalDateKey } from "../utils/recurrence";
import { formatHm } from "../utils/format";

/**
 * 日历页 —— 左侧「单日卡片」+ 右侧「月历网格」，带农历 / 节气 / 节假日。
 *
 * 数据源（UAPI，域名 https://uapis.cn/* 已在 capabilities 的 http:allow-fetch 白名单）：
 * - 节假日/万年历：GET /api/v1/misc/holiday-calendar?month=YYYY-MM（date/month/year 三选一）
 *   返回 { mode, days:[{date,day,weekday_cn,is_weekend,is_workday,is_rest_day,is_holiday,
 *          legal_holiday_name?,legal_holiday_type?,solar_festival?,solar_term?,lunar_festival?,
 *          lunar_month_name?,lunar_day_name?,ganzhi_*}], holidays:[{date,name,type}] }
 * - 农历（单日兜底）：GET /api/v1/misc/lunartime?date=YYYY-MM-DD
 *   返回 { weekday_cn,lunar_year,lunar_month_cn,lunar_day_cn,ganzhi_*,zodiac,solar_term }
 *
 * 约束：外部请求必须用 @tauri-apps/plugin-http 的 fetch（全局 fetch 会被 CORS 拦）；
 * 接口失败一律优雅降级（只显示公历），不报错、不空白；结果按「月 / 日」缓存避免重复请求。
 */

const WEEKDAY_HEAD: { key: string }[] = [
  { key: "calendar.weekdayShort.0" },
  { key: "calendar.weekdayShort.1" },
  { key: "calendar.weekdayShort.2" },
  { key: "calendar.weekdayShort.3" },
  { key: "calendar.weekdayShort.4" },
  { key: "calendar.weekdayShort.5" },
  { key: "calendar.weekdayShort.6" },
];
const WEEKDAY_CN: { key: string }[] = [
  { key: "calendar.weekdayFull.0" },
  { key: "calendar.weekdayFull.1" },
  { key: "calendar.weekdayFull.2" },
  { key: "calendar.weekdayFull.3" },
  { key: "calendar.weekdayFull.4" },
  { key: "calendar.weekdayFull.5" },
  { key: "calendar.weekdayFull.6" },
];
const MS_PER_DAY = 86400000;

// ===== 配色常量（集中定义便于日后换肤；能走主题变量的都走变量）=====
/** 主强调色（今天底色 / 选中描边） */
const ACCENT = "var(--island-accent)";
/** 实心 accent 色块上的文字：今天那格底是 accent，深浅主题都必须用白色 */
const ON_ACCENT = "#ffffff";
/** 月视图正文文字：随主题（深色=白 / 浅色=近黑）——原来是写死的 #ffffff，浅色主题下白字白底看不见 */
const TEXT_PRIMARY = "var(--island-text)";
/** 次级小字（农历）：主题的 muted，纯正文字色会让 8px 小字发糊 */
const TEXT_SUB = "var(--island-text-muted)";
/** 节气/节日小字：随主题换深浅（深色=亮蓝 / 浅色=深蓝） */
const FESTIVAL_BLUE = "var(--cal-festival)";
/** 调休上班角标：红底白「班」（彩色牌上的白字深浅主题都成立，不随主题走） */
const BADGE_WORK_BG = "#ff5a5f";
/** 休息日暖红（日号 / 假日徽标文字）：随主题换深浅 */
const HOLIDAY_COLOR = "var(--cal-holiday)";
/** 休息日格的极淡底色：随主题换深浅 */
const REST_CELL_BG = "var(--cal-rest-cell)";
/** 年份下拉可跳范围：当前年 ±5 */
const YEAR_RANGE = 5;

interface UapiDay {
  date: string;
  day: number;
  weekday_cn?: string;
  is_weekend?: boolean;
  is_workday?: boolean;
  is_rest_day?: boolean;
  is_holiday?: boolean;
  legal_holiday_name?: string;
  legal_holiday_type?: string;
  solar_festival?: string;
  solar_term?: string;
  lunar_festival?: string;
  lunar_month_name?: string;
  lunar_day_name?: string;
  ganzhi_year?: string;
  ganzhi_month?: string;
  ganzhi_day?: string;
}

interface UapiMonthResp {
  mode?: string;
  days?: UapiDay[];
}

interface UapiLunarResp {
  weekday_cn?: string;
  lunar_year?: number;
  lunar_month_cn?: string;
  lunar_day_cn?: string;
  ganzhi_year?: string;
  ganzhi_month?: string;
  ganzhi_day?: string;
  zodiac?: string;
  solar_term?: string;
}

/** 月度缓存：key = "YYYY-MM"；仅缓存成功结果 */
const monthCache = new Map<string, Map<string, UapiDay>>();
/** 单日缓存：key = "YYYY-MM-DD"（月数据缺失时的农历兜底） */
const dayCache = new Map<string, UapiDay>();
/** 并发去重：同一个月/日不重复请求 */
const inflight = new Map<string, Promise<Map<string, UapiDay> | null>>();
const inflightDay = new Map<string, Promise<UapiDay | null>>();

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}
function monthKey(y: number, m: number): string {
  return `${y}-${pad2(m + 1)}`;
}
/** 周一=0 … 周日=6 */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

async function loadMonth(year: number, month: number): Promise<Map<string, UapiDay> | null> {
  const key = monthKey(year, month);
  const cached = monthCache.get(key);
  if (cached) return cached;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const resp = await fetch(
        `https://uapis.cn/api/v1/misc/holiday-calendar?month=${encodeURIComponent(key)}`
      );
      if (!resp.ok) return null;
      const json = (await resp.json()) as UapiMonthResp;
      const list = json?.days ?? [];
      if (list.length === 0) return null;
      const map = new Map<string, UapiDay>();
      for (const d of list) if (d?.date) map.set(d.date, d);
      monthCache.set(key, map);
      return map;
    } catch {
      return null; // 降级：只显示公历
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

async function loadDay(dateStr: string): Promise<UapiDay | null> {
  const cached = dayCache.get(dateStr);
  if (cached) return cached;
  const running = inflightDay.get(dateStr);
  if (running) return running;

  const task = (async () => {
    try {
      const resp = await fetch(
        `https://uapis.cn/api/v1/misc/lunartime?date=${encodeURIComponent(dateStr)}`
      );
      if (!resp.ok) return null;
      const json = (await resp.json()) as UapiLunarResp;
      if (!json) return null;
      const day: UapiDay = {
        date: dateStr,
        day: Number(dateStr.slice(8, 10)),
        weekday_cn: json.weekday_cn,
        lunar_month_name: json.lunar_month_cn,
        lunar_day_name: json.lunar_day_cn,
        solar_term: json.solar_term,
        ganzhi_year: json.ganzhi_year,
        ganzhi_month: json.ganzhi_month,
        ganzhi_day: json.ganzhi_day,
      };
      dayCache.set(dateStr, day);
      return day;
    } catch {
      return null;
    } finally {
      inflightDay.delete(dateStr);
    }
  })();

  inflightDay.set(dateStr, task);
  return task;
}

/** 该月按周一起始排布（月外为 null） */
function buildMonthGrid(year: number, month: number): (number | null)[] {
  const lead = mondayIndex(new Date(year, month, 1));
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** 网格/卡片里那行小字：节日 > 节气 > 农历（初一显示月名，否则显示日名） */
function smallText(info: UapiDay | null | undefined): string {
  if (!info) return "";
  const lunarFestival = info.lunar_festival;
  if (lunarFestival) return lunarFestival;
  if (info.solar_festival && info.solar_festival !== info.legal_holiday_name) {
    return info.solar_festival;
  }
  if (info.solar_term) return info.solar_term;
  if (info.lunar_day_name === "初一" && info.lunar_month_name) return info.lunar_month_name;
  return info.lunar_day_name ?? "";
}

/** 是否节气/节日（用于把那行小字染蓝） */
function isFestivalText(info: UapiDay | null | undefined): boolean {
  if (!info) return false;
  return Boolean(info.lunar_festival || info.solar_festival || info.solar_term);
}

/** 是否「休」：法定假日或调休休息（左侧卡片沿用） */
function isRest(info: UapiDay | null | undefined): boolean {
  if (!info) return false;
  return info.legal_holiday_type === "rest" || (info.is_rest_day === true && info.is_holiday === true);
}
/** 是否「班」（调休上班） */
function isAdjustedWorkday(info: UapiDay | null | undefined): boolean {
  return info?.legal_holiday_type === "workday_adjust";
}
/**
 * 月视图网格是否显示「休」徽标的口径：
 * 只在**有法定节假日语义**的休息日显示（legal_holiday_type==="rest" 或有 legal_holiday_name），
 * 普通周六周日不显示 —— 否则一个月里会有 8~10 个徽标，噪音过大。
 */
function isLegalRest(info: UapiDay | null | undefined): boolean {
  if (!info) return false;
  return info.legal_holiday_type === "rest" || Boolean(info.legal_holiday_name);
}

/**
 * 日期英雄块底部的「这一天是什么日子」徽标：法定假日名 > 调休上班 > 休息日 > 无。
 * 网格里原来用 14px 的圆角小徽标（休/班）标同一件事，一个月会出现 8~10 个彩色小圆点，
 * 是密集月历里最吵的一层；语义改由**格内文字**（"班"）+ 底色承担，徽标只在
 * 「选中那一天」的英雄块里出现一次。
 */
function dayBadge(
  info: UapiDay | null | undefined
): { text: string; tone: "rest" | "work" } | null {
  if (!info) return null;
  if (isAdjustedWorkday(info)) return { text: "调休上班", tone: "work" };
  if (info.legal_holiday_name) return { text: info.legal_holiday_name, tone: "rest" };
  if (isRest(info)) return { text: "休息日", tone: "rest" };
  return null;
}

/** ISO 周数（周一为一周之始，第 1 周含当年第一个周四） */
function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // 周一=0
  t.setDate(t.getDate() - day + 3); // 移到本周四
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fday + 3);
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
}

/** 年内第几天（1-366） */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.round((d.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

export default function CalendarPage({
  visible = true,
  onOpenSchedule,
}: {
  visible?: boolean;
  /** 双击某天 / 点「当日日程」块时跳到日程页并定位到那天 */
  onOpenSchedule?: (date: Date) => void;
}) {
  const { t } = useI18n();
  const today = useRef(new Date()).current;
  const [cursor, setCursor] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
  }));
  /** 选中日期（默认今天）；左侧卡片跟随它 */
  const [selected, setSelected] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
    day: today.getDate(),
  }));
  const [monthMap, setMonthMap] = useState<Map<string, UapiDay> | null>(null);
  const [dayInfo, setDayInfo] = useState<UapiDay | null>(null);

  const cursorKey = monthKey(cursor.year, cursor.month);
  const selectedKey = ymd(selected.year, selected.month, selected.day);

  // 拉取当前显示月份的万年历（缓存命中则不发请求）
  useEffect(() => {
    let alive = true;
    const cached = monthCache.get(cursorKey);
    if (cached) {
      setMonthMap(cached);
      return;
    }
    setMonthMap(null);
    void loadMonth(cursor.year, cursor.month).then((map) => {
      if (alive) setMonthMap(map);
    });
    return () => {
      alive = false;
    };
  }, [cursorKey, cursor.year, cursor.month]);

  // 左侧卡片的单日信息：优先取当月数据；缺失（如跨月选中）时用农历接口兜底
  useEffect(() => {
    const fromMonth = monthMap?.get(selectedKey);
    if (fromMonth) {
      setDayInfo(fromMonth);
      return;
    }
    let alive = true;
    const cached = dayCache.get(selectedKey);
    if (cached) {
      setDayInfo(cached);
      return;
    }
    setDayInfo(null);
    void loadDay(selectedKey).then((d) => {
      if (alive) setDayInfo(d);
    });
    return () => {
      alive = false;
    };
  }, [selectedKey, monthMap]);

  const cells = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month),
    [cursor.year, cursor.month]
  );

  // ── 日程叠加层 ─────────────────────────────────────────
  // 圆点与左卡列表都从这里取：`scheduleEvents` 只当"变更信号"用，
  // 真正的展开结果由 store 现算（重复规则 + 单次例外都在 expandEvent 里）。
  const scheduleEvents = useScheduleStore((s) => s.events);
  const scheduleLoaded = useScheduleStore((s) => s.loaded);
  const loadSchedule = useScheduleStore((s) => s.load);

  useEffect(() => {
    if (!scheduleLoaded) void loadSchedule();
  }, [scheduleLoaded, loadSchedule]);

  /** 当月每天有哪些日程（跨天事件归到开始日，与日程页同口径） */
  const monthOccurrences = useMemo(() => {
    const from = new Date(cursor.year, cursor.month, 1);
    const to = endOfDay(new Date(cursor.year, cursor.month + 1, 0));
    const buckets = new Map<string, Occurrence[]>();
    for (const occ of useScheduleStore.getState().occurrencesInRange(from, to)) {
      if (occ.cancelled) continue;
      const key = toLocalDateKey(occ.start);
      const list = buckets.get(key);
      if (list) list.push(occ);
      else buckets.set(key, [occ]);
    }
    return buckets;
  }, [cursor.year, cursor.month, scheduleEvents]);

  const selectedOccurrences = monthOccurrences.get(selectedKey) ?? [];

  /** 双击判定（250ms 内同一格两次）：单击只选中，双击跳日程页 */
  const lastClickRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const shiftMonth = useCallback((delta: number) => {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }, []);

  /**
   * 跳转到指定年/月（顶部下拉用）。
   * 选中日口径：**保持原来的"日"号**（只换年月），若该月没有这一天（如 31 日跳到 2 月），
   * 钳到该月最后一天，避免出现不存在的日期。
   */
  const jumpTo = useCallback((year: number, month: number) => {
    setCursor({ year, month });
    setSelected((s) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return { year, month, day: Math.min(s.day, lastDay) };
    });
  }, []);

  /** 回到当前月并选中今天 */
  const goToday = useCallback(() => {
    setCursor({ year: today.getFullYear(), month: today.getMonth() });
    setSelected({
      year: today.getFullYear(),
      month: today.getMonth(),
      day: today.getDate(),
    });
  }, [today]);

  const yearOptions = useMemo(() => {
    const base = today.getFullYear();
    const list: number[] = [];
    for (let y = base - YEAR_RANGE; y <= base + YEAR_RANGE; y++) list.push(y);
    return list;
  }, [today]);

  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  // 左侧卡片展示内容（拿不到农历时只显示公历，不空白）
  const selDayNum = selected.day;
  const selWeekday =
    dayInfo?.weekday_cn ?? t(WEEKDAY_CN[mondayIndex(new Date(selected.year, selected.month, selected.day))].key);
  const selLunar = dayInfo
    ? `${dayInfo.lunar_month_name ?? ""}${dayInfo.lunar_day_name ?? ""}`
    : "";
  // 节日/节气那行（法定假日名改由下方徽标承担，同一件事不说两遍）
  const selFestival =
    dayInfo?.lunar_festival ??
    (dayInfo?.solar_festival && dayInfo.solar_festival !== dayInfo.legal_holiday_name
      ? dayInfo.solar_festival
      : undefined) ??
    dayInfo?.solar_term ??
    "";
  const selGanzhi = dayInfo?.ganzhi_day ? `${dayInfo.ganzhi_year ?? ""}年 ${dayInfo.ganzhi_day}日` : "";
  const selBadge = dayBadge(dayInfo);
  // 选中日期的"年内进度"（Windhawk 口径里的 %weeknum% / %dayofyear%）
  const selDate = new Date(selected.year, selected.month, selected.day);
  const selWeekNo = isoWeek(selDate);
  const selDayNo = dayOfYear(selDate);

  // 有日程时：**不删任何原有信息**（农历/节气/干支/年内进度都照旧），
  // 只把整块内容收紧上移，日程接在下方 —— 用户口径「原内容上移，下方展示日程」。
  const hasEvents = selectedOccurrences.length > 0;

  return (
    // 内边距口径 = 线框稿 expand 规格 `14px 18px`（与音乐详情页、通知页同一套）。
    // 布局 = 两栏：左「日期英雄块」读日期，右「月历」挑日期，中间一条发丝线分组。
    <div className="w-full h-full flex gap-[18px] px-[18px] py-[14px]" style={{ color }}>
      {/* ===== 左：日期英雄块 =====
          原来是一张 94px 窄卡（30px 日号 + 一串 8.5~9.5px 小字），既挤在窄条里、
          又和右边网格争注意力。现在给足一栏：日号 46px 是全页重心，
          "这一天是什么日子"自上而下依次读完（星期 → 日号 → 农历 → 节日 → 徽标 → 干支 → 年内进度）。 */}
      <div
        className="shrink-0 flex flex-col items-center justify-center text-center overflow-hidden"
        style={{
          width: 148,
          minWidth: 0,
          paddingRight: 18,
          borderRight: "1px solid var(--island-border)",
        }}
      >
        <div className="text-[11px] truncate" style={{ color: muted, letterSpacing: 0.6 }}>
          {selWeekday}
        </div>
        <div
          className="tabular-nums leading-none"
          style={{
            fontSize: hasEvents ? 38 : 46,
            fontWeight: 600,
            marginTop: hasEvents ? 0 : 2,
            color: isRest(dayInfo) ? HOLIDAY_COLOR : color,
          }}
        >
          {pad2(selDayNum)}
        </div>
        {selLunar && (
          <div className="text-[11px] truncate max-w-full" style={{ marginTop: hasEvents ? 3 : 7, color: TEXT_PRIMARY, opacity: 0.8 }}>
            {selLunar}
          </div>
        )}
        {selFestival && (
          <div className="text-[10px] truncate max-w-full" style={{ marginTop: hasEvents ? 2 : 5, color: "var(--island-accent)" }}>
            {selFestival}
          </div>
        )}
        {selBadge && (
          <div
            className="text-[10px] truncate max-w-full"
            style={{
              marginTop: hasEvents ? 5 : 8,
              padding: "3px 8px",
              borderRadius: 6,
              background: selBadge.tone === "rest" ? "var(--cal-rest-pill-bg)" : "var(--cal-work-pill-bg)",
              color: selBadge.tone === "rest" ? "var(--cal-rest-pill-fg)" : "var(--cal-work-pill-fg)",
            }}
          >
            {selBadge.text}
          </div>
        )}
        {/* 干支 / 年内进度：**有日程也照样显示**，只是间距收紧（用户口径：原内容上移，
            日程接在下方；以前有日程就把这两行顶掉，日期那天看着像换了张卡）。 */}
        {selGanzhi && (
          <div className="text-[9px] truncate max-w-full" style={{ marginTop: hasEvents ? 6 : 10, color: muted, opacity: 0.5 }}>
            {selGanzhi}
          </div>
        )}
        <div className="text-[9px] truncate max-w-full" style={{ marginTop: hasEvents ? 2 : 4, color: muted, opacity: 0.38 }}>
          {t("calendar.weekOfYear", { week: selWeekNo, day: selDayNo })}
        </div>
        {/* 当日日程（最多 3 条）。左卡只有 148px 宽，所以只给「时刻 + 标题」两列。 */}
        {hasEvents && (
          <button
            type="button"
            onClick={() => onOpenSchedule?.(selDate)}
            title={t("calendar.openSchedule")}
            className="w-full flex flex-col cursor-pointer"
            style={{
              marginTop: hasEvents ? 5 : 8,
              gap: 2,
              padding: "4px 5px",
              borderRadius: 6,
              background: "var(--sidebar-tab-hover)",
              border: "none",
              color: TEXT_PRIMARY,
              textAlign: "left",
            }}
          >
            {selectedOccurrences.slice(0, 3).map((occ) => (
              <span key={`${occ.event.id}:${occ.occurrenceDate}`} className="flex items-baseline" style={{ gap: 4 }}>
                <span
                  className="tabular-nums shrink-0"
                  style={{ fontSize: 8, color: muted, opacity: 0.8, width: 24 }}
                >
                  {occ.event.allDay ? t("calendar.allDayShort") : formatHm(occ.start)}
                </span>
                <span className="truncate" style={{ fontSize: 8.5, lineHeight: 1.35 }}>
                  {occ.event.title}
                </span>
              </span>
            ))}
            {selectedOccurrences.length > 3 && (
              <span className="truncate" style={{ fontSize: 8, color: muted, opacity: 0.75 }}>
                {t("calendar.moreEvents", { count: selectedOccurrences.length - 3 })}
              </span>
            )}
          </button>
        )}
      </div>

      {/* ===== 右：月历 ===== */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶部：月份就是这一列最强的文字（15px 半粗），年/月本身就是两个可点的下拉
            （外观交给 SelectBox），前后月紧贴其右；「今天」只在偏离当前月时出现。
            原来是两个 11px 的裸下拉 + 18px 图标按钮，整行读起来像工具条而不是"标题"。 */}
        <div className="flex items-center shrink-0" style={{ height: 26 }}>
          <NavButton label={t("calendar.prevMonth")} onClick={() => shiftMonth(-1)}>
            <path d="M15 5l-7 7 7 7" />
          </NavButton>

          <DropMenu
            ariaLabel={t("calendar.selectYear")}
            value={cursor.year}
            options={yearOptions}
            format={(y) => t("calendar.yearFormat", { year: y })}
            visible={visible}
            onChange={(v) => jumpTo(v, cursor.month)}
          />

          <DropMenu
            ariaLabel={t("calendar.selectMonth")}
            value={cursor.month + 1}
            options={Array.from({ length: 12 }, (_, i) => i + 1)}
            format={(m) => t("calendar.monthFormat", { month: m })}
            columns={3}
            visible={visible}
            onChange={(v) => jumpTo(cursor.year, v - 1)}
          />

          <NavButton label={t("calendar.nextMonth")} onClick={() => shiftMonth(1)}>
            <path d="M9 5l7 7-7 7" />
          </NavButton>

          {/* 「今天」紧贴「下一月」右侧（用户既定口径：不是行尾、不是月份左侧）；
              且只在显示的年月 ≠ 系统当前年月时渲染（当前月隐藏、不占位） */}
          {(cursor.year !== new Date().getFullYear() ||
            cursor.month !== new Date().getMonth()) && (
            <button
              type="button"
              onClick={goToday}
              data-tip={t("calendar.backToday")}
              data-tip-pos="bottom"
              className="text-[10px] leading-none px-2 py-1 rounded-[6px] cursor-pointer shrink-0 ml-1.5"
              style={{
                background: "var(--sidebar-tab-hover)",
                border: "none",
                color: TEXT_PRIMARY,
                transition: "background-color 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--sidebar-tab-active-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--sidebar-tab-hover)";
              }}
            >
              {t("calendar.today")}
            </button>
          )}
        </div>

        {/* 星期表头：比原来的 9px/高不透明度更收敛，别和日期数字抢读 */}
        <div
          className="grid shrink-0"
          style={{ gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginTop: 7 }}
        >
          {WEEKDAY_HEAD.map((w, i) => (
            <div
              key={w.key}
              className="text-center"
              style={{
                fontSize: 9.5,
                color: TEXT_SUB,
                opacity: i >= 5 ? 0.6 : 0.9,
              }}
            >
              {t(w.key)}
            </div>
          ))}
        </div>

        {/* 网格：6 行自适应。语义全部落在格内，不再用角落小圆徽标
            （原来一个月会出现 8~10 个彩色圆点，是这块最吵的一层）：
              · 法定休息日 → 暖红色日号 + 极淡暖底
              · 调休上班   → 副行显示「班」（琥珀色），代替那天的农历小字
              · 今天       → 蓝底白字；选中 → 蓝色发丝环 */}
        <div
          key={`${cursor.year}-${cursor.month}`}
          className="grid flex-1 min-h-0 panel-swap"
          style={{
            gridTemplateColumns: "repeat(7, 1fr)",
            gridTemplateRows: `repeat(${Math.max(cells.length / 7, 1)}, 1fr)`,
            gap: 2,
            marginTop: 5,
          }}
        >
          {cells.map((day, idx) => {
            if (day === null) return <div key={`empty-${idx}`} />;
            const key = ymd(cursor.year, cursor.month, day);
            const info = monthMap?.get(key);
            const isToday =
              today.getFullYear() === cursor.year &&
              today.getMonth() === cursor.month &&
              today.getDate() === day;
            const isSelected =
              selected.year === cursor.year &&
              selected.month === cursor.month &&
              selected.day === day;
            const festival = isFestivalText(info);
            const sub = smallText(info);
            const rest = isLegalRest(info);
            const adjust = isAdjustedWorkday(info);
            const dayDate = new Date(cursor.year, cursor.month, day);
            const dayOccurrences = monthOccurrences.get(key) ?? [];

            /** 单击选中；250ms 内同格第二次 = 双击 → 跳日程页. */
            const handleCellClick = () => {
              const stamp = Date.now();
              const last = lastClickRef.current;
              setSelected({ year: cursor.year, month: cursor.month, day });
              if (last.key === key && stamp - last.at <= 250) {
                lastClickRef.current = { key: "", at: 0 };
                onOpenSchedule?.(dayDate);
                return;
              }
              lastClickRef.current = { key, at: stamp };
            };

            // 今天：蓝底白字；选中：蓝色发丝环（今天同时被选中则蓝底 + 外描边/发光）
            const restBg = REST_CELL_BG;
            const boxBackground = isToday ? ACCENT : rest ? restBg : "transparent";
            let boxShadow = "none";
            if (isToday && isSelected) {
              boxShadow = `0 0 0 1.5px ${ACCENT}, 0 0 6px rgba(10,132,255,0.55)`;
            } else if (isSelected) {
              boxShadow = `inset 0 0 0 1.5px ${ACCENT}`;
            }

            return (
              <button
                key={key}
                type="button"
                onClick={handleCellClick}
                className="cal-cell relative flex flex-col items-center justify-center rounded-[6px] cursor-pointer overflow-hidden"
                style={{
                  background: boxBackground,
                  border: "none",
                  padding: 0,
                  color: TEXT_PRIMARY,
                  boxShadow,
                  transition: "background-color 150ms ease, box-shadow 150ms ease",
                }}
                data-tip={
                  info
                    ? `${key} ${info.weekday_cn ?? ""} ${info.lunar_month_name ?? ""}${info.lunar_day_name ?? ""}`
                    : key
                }
                onMouseEnter={(e) => {
                  if (!isToday) e.currentTarget.style.background = "var(--sidebar-tab-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isToday) e.currentTarget.style.background = rest ? restBg : "transparent";
                }}
              >
                <span
                  className="tabular-nums leading-none"
                  style={{
                    fontSize: 11,
                    fontWeight: isToday || isSelected ? 600 : rest ? 600 : 400,
                    // 休息日：暖红日号（原来的「休」圆徽标改由颜色承担）；
                    // 今天那格是 accent 实心底，必须用白字（浅色主题的正文字色是近黑）
                    color: isToday ? ON_ACCENT : rest ? HOLIDAY_COLOR : TEXT_PRIMARY,
                    opacity: isToday ? 1 : 0.92,
                  }}
                >
                  {day}
                </span>
                {sub && (
                  <span
                    className="leading-none truncate max-w-full"
                    style={{
                      fontSize: 8,
                      marginTop: 2,
                      // 节气/节日=蓝；该格是今天时白色；普通农历白色 55%
                      color: isToday ? "rgba(255,255,255,0.85)" : festival ? FESTIVAL_BLUE : TEXT_SUB,
                      opacity: isToday ? 1 : 0.95,
                    }}
                  >
                    {sub}
                  </span>
                )}

                {/* 右上角角标（用户要求保留：一个月里哪几天休、哪几天调休上班要能一眼扫出来）
                    班 = 始终红底白字（今天那格是蓝底，红牌在蓝底上最清楚；用户反馈过
                    跟着格子变蓝底看不清）；休 = 蓝底蓝牌会隐形，所以今天那格改半透明黑底。 */}
                {adjust && <CellChip text={t("calendar.work")} background={BADGE_WORK_BG} />}
                {!adjust && rest && (
                  <CellChip text={t("calendar.rest")} background={isToday ? "rgba(0,0,0,0.42)" : ACCENT} />
                )}

                {/* 日程小圆点：放左上（右上是休/班角标），最多 3 个；
                    全天事件用实心 accent，定时事件用半透明蓝，扫一眼能分清。
                    今天那格是蓝底，圆点必须换成白/淡色，否则隐形。 */}
                {dayOccurrences.length > 0 && (
                  <span
                    className="absolute flex items-center"
                    style={{ top: 2, left: 2, gap: 1.5, pointerEvents: "none" }}
                  >
                    {dayOccurrences.slice(0, 3).map((occ, dotIndex) => (
                      <span
                        key={dotIndex}
                        style={{
                          width: 3,
                          height: 3,
                          borderRadius: 999,
                          background: isToday
                            ? ON_ACCENT
                            : occ.event.allDay
                              ? ACCENT
                              : "rgba(10,132,255,0.55)",
                        }}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * 月历格子右上角的「休 / 班」角标。
 * 用户明确要求保留：一个月里哪几天休、哪几天调休上班，要能一眼扫出来。
 * 做成 11px 高的小圆角牌（不是原来 14px 的圆点），醒目但不至于把格子塞满。
 */
function CellChip({ text, background }: { text: string; background: string }) {
  return (
    <span
      className="absolute flex items-center justify-center"
      style={{
        top: 1,
        right: 1,
        minWidth: 11,
        height: 11,
        padding: "0 2px",
        borderRadius: 3,
        background,
        color: "#ffffff",
        fontSize: 8,
        lineHeight: 1,
        fontWeight: 600,
        pointerEvents: "none",
      }}
    >
      {text}
    </span>
  );
}

/**
 * 年月下拉（自绘，替代原生 <select>）。
 * 原生 select 展开的那张列表由 Chromium 自己绘制，圆角/底色/阴影一律控制不了，
 * 在深色玻璃岛里就是一块系统灰白面板。这里自绘浮层：12px 圆角 + 发丝描边 +
 * 柔和阴影 + 6px 内边距；月份用 3 列网格（12 项一次铺满、不用滚），年份用单列
 * 可滚列表（限高 168px —— 岛体是 overflow:hidden，浮层必须留在岛内）。
 * 关闭时机：选中一项 / 点浮层外 / Esc / 离开日历页（visible=false）。
 */
function DropMenu({
  ariaLabel,
  value,
  options,
  format,
  columns = 1,
  visible,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  options: number[];
  format: (v: number) => string;
  columns?: 1 | 3;
  visible: boolean;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 翻到音乐/通知页时收起，免得回到日历页还挂着一张旧菜单
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  // 点浮层之外关闭；Esc 关闭并**拦下这次按键**——岛根节点的 Esc 会退出展开态，
  // 菜单开着时按 Esc 只应该收菜单。岛上的键盘监听挂在 window 的冒泡阶段，
  // 这里在 document 的捕获阶段先拿到并阻止继续传播。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center cursor-pointer"
        style={{
          border: "none",
          borderRadius: 7,
          padding: "3px 7px",
          background: open ? "var(--sidebar-tab-active)" : "transparent",
          color: TEXT_PRIMARY,
          // 15px 半粗：年/月是这一列最强的文字（原来 11px，读起来像工具条标签）
          fontSize: 15,
          fontWeight: 600,
          lineHeight: 1,
          transition: "background-color 150ms ease",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "var(--sidebar-tab-hover)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        {format(value)}
        <span
          style={{
            marginLeft: 5,
            fontSize: 7.5,
            color: TEXT_SUB,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 160ms ease",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 6,
            zIndex: 40,
            width: columns === 3 ? 132 : 84,
            maxHeight: 168,
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: 6,
            borderRadius: 12,
            // 浮层用主题的"更高一层表面"：深色主题比岛体略亮、浅色主题接近纯白，
            // 否则浅色主题下会掉下一块深色面板
            background: "var(--popover-bg)",
            border: "1px solid var(--island-border)",
            boxShadow: "var(--popover-shadow)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: columns === 3 ? "repeat(3, 1fr)" : "1fr",
              gap: 2,
            }}
          >
            {options.map((v) => {
              const activeOption = v === value;
              return (
                <button
                  key={v}
                  type="button"
                  role="option"
                  aria-selected={activeOption}
                  onClick={() => {
                    onChange(v);
                    setOpen(false);
                  }}
                  className="flex items-center justify-center cursor-pointer tabular-nums"
                  style={{
                    height: 24,
                    padding: "0 6px",
                    border: "none",
                    borderRadius: 7,
                    background: activeOption ? "rgba(10,132,255,0.22)" : "transparent",
                    color: activeOption ? TEXT_PRIMARY : TEXT_SUB,
                    fontSize: 12,
                    fontWeight: activeOption ? 600 : 400,
                    lineHeight: 1,
                    transition: "background-color 140ms ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!activeOption) e.currentTarget.style.background = "var(--sidebar-tab-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!activeOption) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {format(v)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-pos="bottom"
      onClick={onClick}
      className="flex items-center justify-center rounded-[6px] cursor-pointer"
      style={{
        // 与 15px 的月份标题同一行，命中区给到 22px（原 18px 偏小）
        width: 22,
        height: 22,
        background: "transparent",
        border: "none",
        color: "var(--island-text)",
        opacity: 0.7,
        transition: "background-color 150ms ease, opacity 150ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
        e.currentTarget.style.background = "var(--sidebar-tab-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "0.7";
        e.currentTarget.style.background = "transparent";
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
    </button>
  );
}
