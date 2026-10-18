import { useEffect, useMemo, useRef, useState } from "react";
import Hint from "../components/Hint";
import ScheduleEditor from "../components/schedule/ScheduleEditor";
import { useI18n } from "../i18n";
import { useInnerScroll } from "../hooks/useInnerScroll";
import { useScheduleStore } from "../stores/schedule";
import { parseIcs } from "../services/ics";
import { addDays, endOfDay, startOfDay, toLocalDateKey } from "../utils/recurrence";
import { formatHm } from "../utils/format";
import type { CalendarEvent, Occurrence } from "../types/schedule";

/**
 * 日程页 —— 展开态第 3 页（音乐 / 日历 / 日程 / 通知）。
 *
 * 为什么是"从今天起的 7 天滚动窗口"而不是月历：岛的展开态只有 530×280，
 * 月历已经在日历页了；这一页要回答的是"接下来这几天我要干什么"，
 * 所以按天分组、只列有内容的天，空白天不占位置（不然 3 条日程会被 4 行
 * 「无日程」冲散）。
 *
 * 跨天：每 60s 检查一次日期，过了零点窗口自动往前挪（anchor 跟今天走）。
 * 从月历跳过来：`focusScheduleDate()` 把 anchor 挪到那一天并高亮一下（S4 用）。
 */

const WINDOW_DAYS = 7;

// ── 跨组件跳转通道（月历页双击 → 日程页定位）──
// 用模块级监听而不是 store：它只影响本页的滚动位置，没有任何持久化价值，
// 放 store 里反而要写一个没人读的字段。
let pendingFocusKey: string | null = null;
const focusListeners = new Set<(dateKey: string) => void>();

/** 从别处（月历页）跳到日程页并定位到某一天 */
export function focusScheduleDate(date: Date): void {
  const key = toLocalDateKey(date);
  pendingFocusKey = key;
  for (const listener of focusListeners) listener(key);
}

export default function SchedulePage({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  const loaded = useScheduleStore((s) => s.loaded);
  const load = useScheduleStore((s) => s.load);
  const occurrencesInRange = useScheduleStore((s) => s.occurrencesInRange);
  // 订阅 events 本身：任何增删改都要重算展开结果
  const events = useScheduleStore((s) => s.events);

  const [today, setToday] = useState(() => startOfDay(new Date()));
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ occurrence: Occurrence | null; date: Date } | null>(
    null
  );
  /** 导入预览：解析完成但还没落盘的一批事件 */
  const [pendingImport, setPendingImport] = useState<{
    events: CalendarEvent[];
    added: number;
    updated: number;
    warnings: string[];
    total: number;
  } | null>(null);
  /** 导入结果的一行反馈（3s 后自动消失） */
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const dayRefs = useRef(new Map<string, HTMLDivElement>());

  // 首次进展开态时读盘（load 内部幂等，重复调用只是再读一次）
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 跨天：过了零点把窗口挪到今天
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      const now = startOfDay(new Date());
      setToday((prev) => (prev.getTime() === now.getTime() ? prev : now));
      setAnchor((prev) => (prev.getTime() === now.getTime() ? prev : now));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  // 监听"从月历跳过来"
  useEffect(() => {
    const onFocus = (dateKey: string) => {
      const [y, m, d] = dateKey.split("-").map(Number);
      const target = startOfDay(new Date(y, m - 1, d));
      // 跳到今天之前的日期没意义（窗口只往后看），钳到今天
      setAnchor((prev) => (target.getTime() < prev.getTime() ? prev : target));
      setFocusKey(dateKey);
      setEditor(null);
    };
    focusListeners.add(onFocus);
    if (pendingFocusKey) {
      const key = pendingFocusKey;
      pendingFocusKey = null;
      onFocus(key);
    }
    return () => {
      focusListeners.delete(onFocus);
    };
  }, []);

  const days = useMemo(() => {
    const from = anchor;
    const to = endOfDay(addDays(anchor, WINDOW_DAYS - 1));
    const occurrences = occurrencesInRange(from, to).filter((occ) => !occ.cancelled);

    const byKey = new Map<string, Occurrence[]>();
    for (const occ of occurrences) {
      const key = toLocalDateKey(occ.start);
      const list = byKey.get(key);
      if (list) list.push(occ);
      else byKey.set(key, [occ]);
    }

    return Array.from({ length: WINDOW_DAYS }, (_, index) => {
      const date = addDays(anchor, index);
      const key = toLocalDateKey(date);
      const todayKey = toLocalDateKey(today);
      const tomorrowKey = toLocalDateKey(addDays(today, 1));
      return {
        key,
        date,
        items: byKey.get(key) ?? [],
        badge:
          key === todayKey
            ? t("schedule.today")
            : key === tomorrowKey
              ? t("schedule.tomorrow")
              : null,
      };
    });
    // t 会随语言切换换引用，故意不进依赖；语言切换时外层组件已重渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, today, events, occurrencesInRange]);

  const shownDays = days.filter((day) => day.items.length > 0);
  const total = shownDays.reduce((sum, day) => sum + day.items.length, 0);

  /**
   * 读 .ics 文件：解析 → 按 uid 与现有事件比对出「新增 N / 更新 M」→ 弹预览。
   *
   * 用 `<input type="file">` 而不是 Rust 侧 rfd：WebView2 里 file input 打开的是
   * 系统选择框，`File.text()` 直接读文本 —— 不需要给前端 fs 权限、不需要加 Rust 依赖，
   * 也不会因为多一个命令就得重启 启动.bat。
   */
  const handleFilePicked = async (file: File | null) => {
    if (!file) return;
    let text = "";
    try {
      text = await file.text();
    } catch {
      setImportNote(t("schedule.import.failed"));
      return;
    }
    const parsed = parseIcs(text);
    if (parsed.events.length === 0) {
      setImportNote(t("schedule.import.empty"));
      return;
    }
    const existingUids = new Set(events.map((item) => item.uid).filter(Boolean) as string[]);
    const added = parsed.events.filter((item) => !item.uid || !existingUids.has(item.uid)).length;
    setPendingImport({
      events: parsed.events,
      added,
      updated: parsed.events.length - added,
      warnings: parsed.warnings,
      total: parsed.stats.vevents,
    });
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    const result = useScheduleStore.getState().upsertImported(pendingImport.events);
    setPendingImport(null);
    setImportNote(t("schedule.import.done", { added: result.added, updated: result.updated }));
  };

  useEffect(() => {
    if (!importNote) return;
    const timer = window.setTimeout(() => setImportNote(null), 3200);
    return () => window.clearTimeout(timer);
  }, [importNote]);

  // 滚动区两端吞掉滚轮，避免"想滚日程却翻了页"（与通知页同一套做法）
  useInnerScroll(listRef, [total, shownDays.length]);

  // 定位到某天：滚到那天的分组，并高亮 1.4s
  useEffect(() => {
    if (!focusKey) return;
    const el = dayRefs.current.get(focusKey);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    const timer = window.setTimeout(() => setFocusKey(null), 1400);
    return () => window.clearTimeout(timer);
  }, [focusKey, shownDays.length]);

  return (
    <div className="w-full h-full flex flex-col relative" style={{ color: "var(--island-text)" }}>
      {/* 顶部条：口径与通知页一致（14px 上、18px 左右、8px 下 + 发丝线） */}
      <div
        className="flex items-baseline justify-between shrink-0"
        style={{ padding: "14px 18px 8px", borderBottom: "1px solid var(--island-border)" }}
      >
        <span className="text-[10px] tabular-nums" style={{ color: "var(--island-text-muted)", letterSpacing: 0.3 }}>
          {t("schedule.pageTitle")}
          <span style={{ opacity: 0.55, marginLeft: 6 }}>{total}</span>
        </span>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span className="text-[9.5px]" style={{ color: "var(--island-text-muted)", opacity: 0.7 }}>
            {t("schedule.rangeHint", { days: WINDOW_DAYS })}
          </span>
          {/* 导入：右上角图标按钮（用户口径 —— 入口在日程页，不进设置） */}
          <Hint label={t("schedule.import")}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={t("schedule.import")}
            className="cursor-pointer flex items-center justify-center"
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              border: "1px solid var(--island-border)",
              background: "transparent",
              color: "var(--island-text-muted)",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--island-text)";
              e.currentTarget.style.borderColor = "var(--island-text-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--island-text-muted)";
              e.currentTarget.style.borderColor = "var(--island-border)";
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M4 21h16" />
            </svg>
          </button>
          </Hint>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ics,text/calendar,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              // 重置 value：同一个文件连选两次也要能再次触发 change
              e.target.value = "";
              void handleFilePicked(file);
            }}
          />
          <Hint label={t("schedule.new")}>
          <button
            type="button"
            onClick={() => setEditor({ occurrence: null, date: anchor })}
            aria-label={t("schedule.new")}
            className="cursor-pointer flex items-center justify-center"
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              border: "1px solid var(--island-border)",
              background: "transparent",
              color: "var(--island-text-muted)",
              fontSize: 12,
              lineHeight: 1,
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--island-text)";
              e.currentTarget.style.borderColor = "var(--island-text-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--island-text-muted)";
              e.currentTarget.style.borderColor = "var(--island-border)";
            }}
          >
            +
          </button>
          </Hint>
        </div>
      </div>

      {/* 列表 */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        style={{ padding: "6px 18px 14px", overscrollBehavior: "contain" }}
      >
        {total === 0 ? (
          <div
            className="h-full flex flex-col items-center justify-center"
            style={{ color: "var(--island-text-muted)", gap: 4 }}
          >
            <span className="text-[11px]">
              {loaded
                ? t("schedule.empty", { days: WINDOW_DAYS })
                : t("notification.loading")}
            </span>
            {loaded && (
              <span className="text-[9.5px]" style={{ opacity: 0.7 }}>
                {t("schedule.emptyHint")}
              </span>
            )}
          </div>
        ) : (
          shownDays.map((day) => (
            <div
              key={day.key}
              ref={(el) => {
                if (el) dayRefs.current.set(day.key, el);
                else dayRefs.current.delete(day.key);
              }}
              style={{ marginBottom: 4 }}
            >
              {/* 日期头：今天/明天用配色强调，其余只给日期 */}
              <div
                className="flex items-center"
                style={{
                  gap: 6,
                  padding: "5px 0 3px",
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  background: focusKey === day.key ? "rgba(10,132,255,0.14)" : "transparent",
                  transition: "background-color 400ms ease",
                }}
              >
                <span
                  className="text-[10px] tabular-nums"
                  style={{
                    color: day.badge ? "var(--island-text)" : "var(--island-text-muted)",
                    fontWeight: day.badge ? 600 : 400,
                  }}
                >
                  {day.badge ?? formatDayHeader(day.date, t)}
                </span>
                <span className="flex-1" style={{ height: 1, background: "var(--island-border)", opacity: 0.6 }} />
              </div>

              {day.items.map((occ, rowIndex) => (
                <Row
                  key={`${occ.event.id}:${occ.occurrenceDate}`}
                  index={rowIndex}
                  occurrence={occ}
                  onClick={() => setEditor({ occurrence: occ, date: occ.start })}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* 导入结果提示（3.2s 自清） */}
      {importNote && (
        <div
          className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
          style={{
            bottom: 10,
            padding: "3px 9px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.62)",
            color: "#ffffff",
            fontSize: 9.5,
            zIndex: 30,
          }}
        >
          {importNote}
        </div>
      )}

      {/* 导入预览：确认前不落盘 */}
      {pendingImport && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.42)", zIndex: 25, padding: 14 }}
        >
          <div
            className="overlay-pop flex flex-col"
            style={{
              width: 300,
              maxWidth: "100%",
              gap: 8,
              padding: 14,
              borderRadius: 10,
              background: "var(--island-bg, rgba(22,22,24,0.98))",
              border: "1px solid var(--island-border)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
            }}
          >
            <span className="text-[12px]" style={{ fontWeight: 600 }}>
              {t("schedule.import.title")}
            </span>
            <span className="text-[10.5px]" style={{ color: "var(--island-text-muted)", lineHeight: 1.5 }}>
              {t("schedule.import.summary", {
                added: pendingImport.added,
                updated: pendingImport.updated,
                total: pendingImport.total,
              })}
            </span>
            {pendingImport.warnings.length > 0 && (
              <span className="text-[9.5px]" style={{ color: "#E0A33E", lineHeight: 1.45 }}>
                {t("schedule.import.warnings", { count: pendingImport.warnings.length })}
              </span>
            )}
            <div className="flex items-center justify-end" style={{ gap: 8, marginTop: 2 }}>
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                className="cursor-pointer"
                style={{ height: 24, padding: "0 10px", borderRadius: 6, border: "1px solid var(--island-border)", background: "transparent", color: "var(--island-text)", fontSize: 10.5 }}
              >
                {t("schedule.cancel")}
              </button>
              <button
                type="button"
                onClick={confirmImport}
                className="cursor-pointer"
                style={{ height: 24, padding: "0 12px", borderRadius: 6, border: "none", background: "#0A84FF", color: "#ffffff", fontSize: 10.5, fontWeight: 600 }}
              >
                {t("schedule.import.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <ScheduleEditor
          occurrence={editor.occurrence}
          defaultDate={editor.date}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

/** 分组标题：今天/明天之外显示「10月21日 周二」 */
function formatDayHeader(date: Date, t: (key: string, params?: Record<string, string | number>) => string): string {
  return t("schedule.dateLabel", {
    m: date.getMonth() + 1,
    d: date.getDate(),
    w: t(`schedule.weekday.${date.getDay()}`),
  });
}

function Row({
  occurrence,
  index,
  onClick,
}: {
  occurrence: Occurrence;
  /** 同一天内的行序，只用于入场动画的错落延迟 */
  index: number;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const { event, start, end } = occurrence;
  const time = event.allDay ? t("schedule.allDay") : formatHm(start);
  const meta = [event.location, event.notes].filter(Boolean).join(" · ");
  const marks = [
    event.recurrence ? t("schedule.repeatBadge") : null,
    occurrence.overridden ? t("schedule.adjusted") : null,
  ].filter(Boolean) as string[];

  // 悬浮提示：列表里的标题/地点/备注都是单行截断的，长内容只能靠提示看全
  const tipDetail = [
    event.allDay ? t("schedule.allDay") : `${formatHm(start)} – ${formatHm(end)}`,
    event.location,
    event.notes,
    marks.join(" · "),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Hint label={event.title} detail={tipDetail}>
      <button
        type="button"
        onClick={onClick}
        className="row-in w-full flex items-start text-left cursor-pointer"
        style={{
          gap: 9,
          padding: "6px 0 6px",
          background: "none",
          border: "none",
          borderBottom: "1px solid transparent",
          color: "var(--island-text)",
          // 入场：同一组内的行自上而下轻微错落（每行 +18ms，最多叠到 5 行）
          animationDelay: `calc(${Math.min(index, 5) * 18}ms * var(--motion-factor, 1))`,
          transition: "background-color 140ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
      >
        <span
          className="text-[10px] tabular-nums shrink-0"
          style={{
            width: 38,
            color: event.allDay ? "var(--island-text-muted)" : "var(--island-text)",
            opacity: event.allDay ? 0.85 : 1,
            paddingTop: 1,
          }}
        >
          {time}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline" style={{ gap: 5 }}>
            <span className="text-[12px] truncate" style={{ lineHeight: 1.35 }}>
              {event.title}
            </span>
            {marks.map((mark) => (
              <span
                key={mark}
                className="text-[8.5px] shrink-0"
                style={{
                  color: "var(--island-text-muted)",
                  opacity: 0.8,
                  border: "1px solid var(--island-border)",
                  borderRadius: 4,
                  padding: "0 3px",
                  lineHeight: "12px",
                }}
              >
                {mark}
              </span>
            ))}
          </span>
          {meta && (
            <span
              className="block text-[10px] truncate"
              style={{ color: "var(--island-text-muted)", lineHeight: 1.3, marginTop: 1 }}
            >
              {meta}
            </span>
          )}
        </span>
      </button>
    </Hint>
  );
}
