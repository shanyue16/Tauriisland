import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetch } from "@tauri-apps/plugin-http";

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

const WEEKDAY_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MS_PER_DAY = 86400000;

// ===== 配色常量（集中定义便于日后换肤；能走主题变量的都走变量）=====
/** 主强调色（今天底色 / 选中描边 / 休息日徽标底） */
const ACCENT = "var(--island-accent)";
/** 月视图正文文字：全部白色 */
const TEXT_PRIMARY = "#ffffff";
/** 次级小字（农历）：白色 65%，纯白会让 7.5px 小字发糊 */
const TEXT_SUB = "rgba(255,255,255,0.65)";
/** 节气/节日小字：亮蓝（比 accent 更亮，保证深色底上可读） */
const FESTIVAL_BLUE = "#5aa9ff";
/** 调休上班徽标：红底白字（原方案"淡灰底+白字"对比度不足，按授权改进） */
const BADGE_WORK_BG = "#ff5a5f";
/** 左侧单日卡片沿用：休息日暖红 */
const HOLIDAY_COLOR = "#ff7a7a";
/** 左侧单日卡片沿用：农历小字 */
const LUNAR_COLOR = "rgba(255,255,255,0.42)";
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

export default function CalendarPage() {
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
    dayInfo?.weekday_cn ?? WEEKDAY_CN[mondayIndex(new Date(selected.year, selected.month, selected.day))];
  const selLunar = dayInfo
    ? `${dayInfo.lunar_month_name ?? ""}${dayInfo.lunar_day_name ?? ""}`
    : "";
  const selFestival =
    dayInfo?.lunar_festival ??
    (dayInfo?.solar_festival && dayInfo.solar_festival !== dayInfo.legal_holiday_name
      ? dayInfo.solar_festival
      : undefined) ??
    dayInfo?.legal_holiday_name ??
    dayInfo?.solar_term ??
    "";
  const selGanzhi = dayInfo?.ganzhi_day ? `${dayInfo.ganzhi_year ?? ""}年 ${dayInfo.ganzhi_day}日` : "";

  return (
    <div className="w-full h-full flex gap-2.5 px-[14px] py-[10px]" style={{ color}}>
      {/* ===== 左：单日卡片（本次不改其配色/布局） ===== */}
      {/* overflow-hidden + minWidth:0：卡宽固定 84px，内部大号日号/徽标/干支可能比
          内容盒更宽（居中时会向两侧溢出），这里裁到卡片圆角内，避免"最左边有内容
          画到岛外"。岛主体本身也已改为 overflow:hidden 作为兜底。 */}
      <div
        className="shrink-0 flex flex-col items-center justify-center rounded-[10px] px-2 py-1.5 overflow-hidden"
        style={{
          width: 94,
          minWidth: 0,
          background: "rgba(255,255,255,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="tabular-nums leading-none"
          style={{
            fontSize: 30,
            fontWeight: 600,
            color: isRest(dayInfo) ? HOLIDAY_COLOR : color,
          }}
        >
          {pad2(selDayNum)}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: muted }}>
          {selWeekday}
        </div>
        {selLunar && (
          <div className="text-[9.5px] mt-0.5 truncate max-w-full" style={{ color: muted, opacity: 0.85 }}>
            {selLunar}
          </div>
        )}
        {selFestival && (
          <div
            className="text-[9px] mt-0.5 truncate max-w-full"
            style={{ color: isRest(dayInfo) ? HOLIDAY_COLOR : "var(--island-accent)" }}
          >
            {selFestival}
          </div>
        )}
        <div className="flex items-center gap-1 mt-1">
          {isRest(dayInfo) && <Badge text="休" tone="rest" />}
          {isAdjustedWorkday(dayInfo) && <Badge text="班" tone="work" />}
        </div>
        {selGanzhi && (
          <div className="text-[8.5px] mt-0.5 truncate max-w-full" style={{ color: muted, opacity: 0.5 }}>
            {selGanzhi}
          </div>
        )}
      </div>

      {/* ===== 右：月历 ===== */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶部：年月跳转 + 今天（「今天」紧贴「下一月」右侧） */}
        <div className="flex items-center shrink-0 gap-0.5">
          <div className="flex items-center gap-0.5">
            <NavButton label="上一月" onClick={() => shiftMonth(-1)}>
              <path d="M15 5l-7 7 7 7" />
            </NavButton>

            <SelectBox
              ariaLabel="选择年份"
              value={cursor.year}
              onChange={(v) => jumpTo(v, cursor.month)}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y} style={{ background: "#1a1d24", color: TEXT_PRIMARY }}>
                  {y}年
                </option>
              ))}
            </SelectBox>

            <SelectBox
              ariaLabel="选择月份"
              value={cursor.month + 1}
              onChange={(v) => jumpTo(cursor.year, v - 1)}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m} style={{ background: "#1a1d24", color: TEXT_PRIMARY }}>
                  {m}月
                </option>
              ))}
            </SelectBox>

            <NavButton label="下一月" onClick={() => shiftMonth(1)}>
              <path d="M9 5l7 7-7 7" />
            </NavButton>

            {/* 「今天」紧贴「下一月」右侧（用户最新要求：不是行尾、不是月份左侧）；
                且只在显示的年月 ≠ 系统当前年月时渲染（当前月隐藏、不占位） */}
            {(cursor.year !== new Date().getFullYear() ||
              cursor.month !== new Date().getMonth()) && (
              <button
                type="button"
                onClick={goToday}
                title="回到今天"
                className="text-[10px] leading-none px-1.5 py-1 rounded-[6px] cursor-pointer shrink-0 ml-0.5"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  border: "none",
                  color: TEXT_PRIMARY,
                  transition: "background-color 150ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.16)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                }}
              >
                今天
              </button>
            )}
          </div>
        </div>

        {/* 星期表头（白色系） */}
        <div
          className="grid shrink-0 mt-0.5"
          style={{ gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}
        >
          {WEEKDAY_HEAD.map((w, i) => (
            <div
              key={w}
              className="text-center text-[9px]"
              style={{ color: TEXT_PRIMARY, opacity: i >= 5 ? 0.55 : 0.9 }}
            >
              {w}
            </div>
          ))}
        </div>

        {/* 网格：6 行自适应 */}
        <div
          className="grid flex-1 min-h-0 mt-0.5"
          style={{
            gridTemplateColumns: "repeat(7, 1fr)",
            gridTemplateRows: `repeat(${Math.max(cells.length / 7, 1)}, 1fr)`,
            gap: 2,
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
            const legalRest = isLegalRest(info);
            const adjust = isAdjustedWorkday(info);

            // 今天：蓝底白字；选中：蓝色描边（今天同时被选中则蓝底 + 外描边/发光）
            const boxBackground = isToday ? ACCENT : "transparent";
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
                onClick={() => setSelected({ year: cursor.year, month: cursor.month, day })}
                className="cal-cell relative flex flex-col items-center justify-center rounded-[6px] cursor-pointer overflow-hidden"
                style={{
                  background: boxBackground,
                  border: "none",
                  padding: 0,
                  color: TEXT_PRIMARY,
                  boxShadow,
                  transition: "background-color 150ms ease, box-shadow 150ms ease",
                }}
                title={
                  info
                    ? `${key} ${info.weekday_cn ?? ""} ${info.lunar_month_name ?? ""}${info.lunar_day_name ?? ""}`
                    : key
                }
                onMouseEnter={(e) => {
                  if (!isToday) e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                }}
                onMouseLeave={(e) => {
                  if (!isToday) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  className="tabular-nums leading-none"
                  style={{
                    fontSize: 10,
                    fontWeight: isToday || isSelected ? 600 : 400,
                    color: TEXT_PRIMARY,
                    opacity: isToday ? 1 : 0.92,
                  }}
                >
                  {day}
                </span>
                {sub && (
                  <span
                    className="leading-none truncate max-w-full"
                    style={{
                      fontSize: 7.5,
                      marginTop: 1,
                      // 节气/节日蓝色；该格是今天时白色；普通农历白色 65%
                      color: isToday ? TEXT_PRIMARY : festival ? FESTIVAL_BLUE : TEXT_SUB,
                      opacity: isToday ? 1 : 0.95,
                    }}
                  >
                    {sub}
                  </span>
                )}

                {/* 右上角徽标：调休上班=红底白「班」；法定休息=蓝底白「休」 */}
                {adjust && <CellBadge text="班" background={BADGE_WORK_BG} />}
                {!adjust && legalRest && <CellBadge text="休" background={ACCENT} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 月视图格子里右上角的小圆徽标（绝对定位，不参与排版） */
function CellBadge({ text, background }: { text: string; background: string }) {
  return (
    <span
      className="absolute flex items-center justify-center rounded-full"
      style={{
        // 放大到 14px、字号 9px（用户反馈原 11px/7px 看不清字）
        top: 0,
        right: 0,
        width: 14,
        height: 14,
        background,
        color: "#ffffff",
        fontSize: 9,
        lineHeight: 1,
        fontWeight: 600,
        pointerEvents: "none",
      }}
    >
      {text}
    </span>
  );
}

/** 顶部年月下拉（原生 select + 自定义深色外观与箭头） */
function SelectBox({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <span className="relative flex items-center">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="text-[11px] font-semibold cursor-pointer rounded-[4px]"
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          background: "transparent",
          border: "none",
          color: TEXT_PRIMARY,
          padding: "0 9px 0 2px",
          outline: "none",
          textAlign: "center",
        }}
      >
        {children}
      </select>
      <span
        className="pointer-events-none absolute right-[2px] text-[7px] leading-none"
        style={{ color: TEXT_SUB }}
      >
        ▾
      </span>
    </span>
  );
}

function Badge({ text, tone }: { text: string; tone: "rest" | "work" }) {
  const rest = tone === "rest";
  return (
    <span
      className="flex items-center justify-center rounded-[4px] text-[8px] leading-none"
      style={{
        width: 14,
        height: 14,
        color: rest ? HOLIDAY_COLOR : "var(--island-text-muted)",
        background: rest ? "rgba(255,122,122,0.14)" : "rgba(255,255,255,0.08)",
      }}
      title={rest ? "休息日" : "调休上班"}
    >
      {text}
    </span>
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
      title={label}
      onClick={onClick}
      className="flex items-center justify-center rounded-[6px] cursor-pointer"
      style={{
        width: 18,
        height: 18,
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
