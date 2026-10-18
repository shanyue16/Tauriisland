import { useEffect, useMemo, useState } from "react";
import Dropdown from "../settings/Dropdown";
import { useI18n } from "../../i18n";
import { useSettings } from "../../stores/settings";
import { useScheduleStore } from "../../stores/schedule";
import { toLocalDateKey } from "../../utils/recurrence";
import { formatHm } from "../../utils/format";
import { DEFAULT_REMINDER_MINUTES } from "../../types/schedule";
import type {
  EventPatch,
  Occurrence,
  Recurrence,
  RecurrenceFreq,
} from "../../types/schedule";

/**
 * 日程编辑弹窗（岛内覆盖层，不是系统窗口）。
 *
 * 为什么做成岛内覆盖层：岛就是一个 530×280 的窗口，开子窗口会跳焦点、还会
 * 在任务栏多一个图标；覆盖层只是本页 z-index 最高的那一层，Esc/取消即可退出。
 *
 * 「重复日程改一次」的三个范围（参考 SleepDown-Schedule 的 product 语义，
 * 但用我们自己的 exceptions 结构表达）：
 * - 仅本次：写 exceptions{action:"override", patch:差异字段}，其余次不动；
 * - 整个系列：改事件本体（含 recurrence）；
 * - 恢复默认：删掉这一条的 exception，让它重新跟随系列。
 */

/** 重复选择：none = 不重复 */
type RepeatChoice = "none" | RecurrenceFreq;
type Scope = "this" | "all" | "reset";

interface FormState {
  title: string;
  /** "YYYY-MM-DD" */
  date: string;
  start: string;
  end: string;
  /** 跨天结束时 end 落在后一天；UI 不单独暴露，只跟随日期联动 */
  endDate: string;
  allDay: boolean;
  location: string;
  notes: string;
  /** "none" / "custom" / 分钟数（字符串，方便直接喂给 Dropdown） */
  reminder: string;
  /** 选了 custom 时的数值与单位（分钟 1-60 / 小时 1-24 / 天 1-30） */
  reminderValue: string;
  reminderUnit: ReminderUnit;
  alarm: boolean;
  repeat: RepeatChoice;
  /** 重复截止（含），"YYYY-MM-DD" 或空 */
  until: string;
}

const REPEAT_OPTIONS: { key: RepeatChoice; labelKey: string }[] = [
  { key: "none", labelKey: "schedule.repeat.none" },
  { key: "DAILY", labelKey: "schedule.repeat.daily" },
  { key: "WEEKLY", labelKey: "schedule.repeat.weekly" },
  { key: "MONTHLY", labelKey: "schedule.repeat.monthly" },
  { key: "YEARLY", labelKey: "schedule.repeat.yearly" },
];

/** 提醒预设；不在预设里的重复值（如 ICS 的 15 分钟）会在下拉里动态补一项 */
const REMINDER_PRESETS = ["none", "0", "5", "10", "30"];

/** 自定义提醒：选它才显示「数值 + 单位」两格 */
const CUSTOM_REMINDER = "custom";

/**
 * 自定义提醒的单位与取值上限（用户口径：分钟 1-60、小时 1-24、天 1-30）。
 * `factor` 是该单位折算成分钟的倍数 —— 落库始终是分钟数（`reminderMinutes`），
 * 单位只是输入时的显示形态。
 */
const REMINDER_UNITS = {
  m: { max: 60, factor: 1, labelKey: "schedule.reminder.unit.minute" },
  h: { max: 24, factor: 60, labelKey: "schedule.reminder.unit.hour" },
  d: { max: 30, factor: 1440, labelKey: "schedule.reminder.unit.day" },
} as const;
type ReminderUnit = keyof typeof REMINDER_UNITS;

const REMINDER_UNIT_OPTIONS = (Object.keys(REMINDER_UNITS) as ReminderUnit[]).map((key) => ({
  key,
  labelKey: REMINDER_UNITS[key].labelKey,
}));

/** 把数值夹到该单位允许的范围（1..max），空串按 1 处理 */
function clampReminderValue(value: string, unit: ReminderUnit): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(REMINDER_UNITS[unit].max, Math.max(1, n));
}

/** 分钟数 → 最合适的「数值 + 单位」（60 分钟显示成「1 小时」而不是「60 分钟」） */
function decomposeReminder(minutes: number): { value: string; unit: ReminderUnit } {
  if (minutes % 1440 === 0 && minutes / 1440 <= REMINDER_UNITS.d.max) {
    return { value: String(minutes / 1440), unit: "d" };
  }
  if (minutes % 60 === 0 && minutes / 60 <= REMINDER_UNITS.h.max) {
    return { value: String(minutes / 60), unit: "h" };
  }
  return { value: String(Math.min(REMINDER_UNITS.m.max, Math.max(1, minutes))), unit: "m" };
}

/** 动态项标记：labelKey 以它开头时，交给 tOption 现算文案 */
const DYNAMIC_REMINDER = "#reminder:";

function initialForm(occurrence: Occurrence | null, defaultDate: Date): FormState {
  if (!occurrence) {
    const date = toLocalDateKey(defaultDate);
    return {
      title: "",
      date,
      start: "09:00",
      end: "10:00",
      endDate: date,
      allDay: false,
      location: "",
      notes: "",
      reminder: String(DEFAULT_REMINDER_MINUTES),
      reminderValue: String(DEFAULT_REMINDER_MINUTES),
      reminderUnit: "m",
      alarm: false,
      repeat: "none",
      until: "",
    };
  }
  const { event, start, end } = occurrence;
  return {
    title: event.title,
    date: toLocalDateKey(start),
    start: formatHm(start),
    end: formatHm(end),
    endDate: toLocalDateKey(end),
    allDay: event.allDay,
    location: event.location ?? "",
    notes: event.notes ?? "",
    // 不在预设里的值（如 ICS 的 15 分钟、或用户自己输的 90 分钟）直接进「自定义」形态，
    // 否则下拉里会出现一项「提前 90 分钟」却没有可编辑的数值框
    ...(event.reminderMinutes === null
      ? { reminder: "none", reminderValue: String(DEFAULT_REMINDER_MINUTES), reminderUnit: "m" as ReminderUnit }
      : REMINDER_PRESETS.includes(String(event.reminderMinutes))
        ? { reminder: String(event.reminderMinutes), reminderValue: String(event.reminderMinutes), reminderUnit: "m" as ReminderUnit }
        : {
            reminder: CUSTOM_REMINDER,
            reminderValue: decomposeReminder(event.reminderMinutes).value,
            reminderUnit: decomposeReminder(event.reminderMinutes).unit,
          }),
    alarm: event.alarmEnabled,
    repeat: (event.recurrence?.freq ?? "none") as RepeatChoice,
    until: event.recurrence?.until ?? "",
  };
}

/** 由表单拼出重复规则（byWeekday/byMonthDay 取开始日） */
function buildRecurrence(form: FormState): Recurrence | null {
  if (form.repeat === "none") return null;
  const day = new Date(`${form.date}T00:00`);
  const rule: Recurrence = { freq: form.repeat, interval: 1 };
  if (form.repeat === "WEEKLY") rule.byWeekday = [day.getDay()];
  if (form.repeat === "MONTHLY") rule.byMonthDay = [day.getDate()];
  if (form.until) rule.until = form.until;
  return rule;
}

export default function ScheduleEditor({
  occurrence,
  defaultDate,
  onClose,
}: {
  /** null = 新建 */
  occurrence: Occurrence | null;
  /** 新建时的默认日期（点的是哪天就落哪天） */
  defaultDate: Date;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useSettings((s) => s.settings.theme);
  const isDark = theme !== "light";

  const createEvent = useScheduleStore((s) => s.createEvent);
  const updateEvent = useScheduleStore((s) => s.updateEvent);
  const removeEvent = useScheduleStore((s) => s.removeEvent);
  const overrideOccurrence = useScheduleStore((s) => s.overrideOccurrence);
  const cancelOccurrence = useScheduleStore((s) => s.cancelOccurrence);
  const resetOccurrence = useScheduleStore((s) => s.resetOccurrence);

  const [form, setForm] = useState<FormState>(() => initialForm(occurrence, defaultDate));
  const [scope, setScope] = useState<Scope>(occurrence?.event.recurrence ? "this" : "all");
  const [error, setError] = useState<"title" | "end" | null>(null);
  /** 删除是两段式：第一次点变「确认删除？」，3 秒内再点才真删 */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSeries = Boolean(occurrence?.event.recurrence);
  // 「仅本次」改重复频率没有意义（会把整条系列的规则改掉），所以禁掉
  const repeatLocked = isSeries && scope === "this";

  const startIso = form.allDay ? `${form.date}T00:00` : `${form.date}T${form.start}`;
  const endIso = form.allDay ? `${form.date}T00:00` : `${form.endDate}T${form.end}`;

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  // Esc 关闭（Dropdown 自己处理浮层内的 Esc，这里只兜底最外层）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const reminderOptions = useMemo(() => {
    const options = REMINDER_PRESETS.map((key) => ({
      key,
      labelKey:
        key === "none"
          ? "schedule.reminder.none"
          : key === "0"
            ? "schedule.reminder.ontime"
            : `${DYNAMIC_REMINDER}${key}`,
    }));
    options.push({ key: CUSTOM_REMINDER, labelKey: "schedule.reminder.custom" });
    if (!options.some((o) => o.key === form.reminder)) {
      options.push({ key: form.reminder, labelKey: `${DYNAMIC_REMINDER}${form.reminder}` });
    }
    return options;
  }, [form.reminder]);

  /** Dropdown 只认 labelKey，动态「提前 N 分钟」在这里现算 */
  const tOption = (key: string) => {
    if (key.startsWith(DYNAMIC_REMINDER)) {
      return t("schedule.reminder.before", { n: key.slice(DYNAMIC_REMINDER.length) });
    }
    return t(key);
  };

  const patchForm = (next: Partial<FormState>) => {
    setForm((prev) => {
      const merged = { ...prev, ...next };
      // 改日期时，若结束日还停在旧日期，跟着一起挪（避免跨天事件被压回当天）
      if (next.date && next.date !== prev.date && prev.endDate === prev.date) {
        merged.endDate = next.date;
      }
      return merged;
    });
    setError(null);
  };

  const save = () => {
    const title = form.title.trim();
    if (!title) {
      setError("title");
      return;
    }
    if (!form.allDay && endIso <= startIso) {
      setError("end");
      return;
    }

    const reminderMinutes =
      form.reminder === "none"
        ? null
        : form.reminder === CUSTOM_REMINDER
          ? clampReminderValue(form.reminderValue, form.reminderUnit) * REMINDER_UNITS[form.reminderUnit].factor
          : Number(form.reminder);
    const recurrence = buildRecurrence(form);
    const common = {
      title,
      start: startIso,
      end: endIso,
      allDay: form.allDay,
      // 清空地点/备注用 ""：exceptions 要经 JSON 落盘，undefined 会被丢掉
      location: form.location.trim(),
      notes: form.notes.trim(),
      reminderMinutes,
      alarmEnabled: form.alarm,
    };

    if (!occurrence) {
      createEvent({ ...common, source: "manual", recurrence, exceptions: [] });
      onClose();
      return;
    }

    const { event, occurrenceDate } = occurrence;

    if (isSeries && scope === "this") {
      const patch = seriesPatch(event, occurrenceDate, common);
      if (Object.keys(patch).length > 0) {
        overrideOccurrence(event.id, occurrenceDate, patch);
      }
      onClose();
      return;
    }

    if (isSeries && scope === "reset") {
      resetOccurrence(event.id, occurrenceDate);
      onClose();
      return;
    }

    updateEvent(event.id, { ...common, recurrence });
    onClose();
  };

  const remove = () => {
    if (!occurrence) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const { event, occurrenceDate } = occurrence;
    if (isSeries && scope === "this") cancelOccurrence(event.id, occurrenceDate);
    else removeEvent(event.id);
    onClose();
  };

  const field: React.CSSProperties = {
    height: 26,
    borderRadius: 7,
    padding: "0 7px",
    fontSize: 11.5,
    width: "100%",
    minWidth: 0,
    background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.045)",
    border: `1px solid ${error === "title" ? "#ff6b6b" : "var(--island-border)"}`,
    color: "var(--island-text)",
    outline: "none",
    // 原生日期/时间选择器的弹层跟随主题
    colorScheme: isDark ? "dark" : "light",
  };

  const label: React.CSSProperties = {
    fontSize: 9.5,
    color: "var(--island-text-muted)",
    marginBottom: 3,
    letterSpacing: 0.2,
  };

  return (
    <div
      className="overlay-pop"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        // 覆盖层要把下面的列表彻底盖住，否则两页文字会互相透
        background: isDark ? "rgba(22,22,24,0.985)" : "rgba(247,247,249,0.985)",
        backdropFilter: "blur(10px)",
        borderRadius: 20,
        border: "1px solid var(--island-border)",
        color: "var(--island-text)",
      }}
    >
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: "10px 14px 6px" }}
      >
        <span className="text-[11px]" style={{ fontWeight: 600 }}>
          {occurrence ? t("schedule.edit") : t("schedule.new")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("schedule.cancel")}
          className="cursor-pointer"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            lineHeight: 1,
            fontSize: 14,
            color: "var(--island-text-muted)",
          }}
        >
          ✕
        </button>
      </div>

      {/* 表单：内容多于一屏时可滚，不撑破 280 高 */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: "0 14px", overscrollBehavior: "contain" }}
      >
        <div style={{ marginBottom: 6 }}>
          <input
            autoFocus
            value={form.title}
            onChange={(e) => patchForm({ title: e.target.value })}
            placeholder={t("schedule.titlePlaceholder")}
            style={{ ...field, height: 28, fontSize: 12.5 }}
          />
        </div>

        {/* 日期 / 开始 / 结束 / 全天 */}
        <div className="flex items-end" style={{ gap: 6, marginBottom: 6 }}>
          <div style={{ flex: "0 0 108px" }}>
            <div style={label}>{t("schedule.date")}</div>
            <input
              type="date"
              value={form.date}
              onChange={(e) => patchForm({ date: e.target.value })}
              style={field}
            />
          </div>
          <div style={{ flex: "0 0 72px" }}>
            <div style={label}>{t("schedule.start")}</div>
            <input
              type="time"
              value={form.start}
              disabled={form.allDay}
              onChange={(e) => patchForm({ start: e.target.value })}
              style={{ ...field, opacity: form.allDay ? 0.4 : 1 }}
            />
          </div>
          <div style={{ flex: "0 0 72px" }}>
            <div style={label}>{t("schedule.end")}</div>
            <input
              type="time"
              value={form.end}
              disabled={form.allDay}
              onChange={(e) => patchForm({ end: e.target.value })}
              style={{ ...field, opacity: form.allDay ? 0.4 : 1 }}
            />
          </div>
          <div className="flex-1" />
          <Switch
            checked={form.allDay}
            onChange={(v) => patchForm({ allDay: v, start: v ? "00:00" : form.start })}
            label={t("schedule.allDayToggle")}
            isDark={isDark}
          />
        </div>

        {/* 重复 / 截止 / 提醒 / 响铃 */}
        <div className="flex items-end" style={{ gap: 6, marginBottom: 6 }}>
          <div style={{ flex: "0 0 96px", opacity: repeatLocked ? 0.45 : 1 }}>
            <div style={label}>{t("schedule.repeat")}</div>
            <Dropdown
              value={form.repeat}
              options={REPEAT_OPTIONS}
              onChange={(v) => !repeatLocked && patchForm({ repeat: v })}
              t={tOption}
              ariaLabel={t("schedule.repeat")}
            />
          </div>
          <div style={{ flex: "0 0 100px", opacity: form.repeat === "none" ? 0.4 : 1 }}>
            <div style={label}>{t("schedule.until")}</div>
            <input
              type="date"
              value={form.until}
              disabled={form.repeat === "none"}
              onChange={(e) => patchForm({ until: e.target.value })}
              style={field}
            />
          </div>
          <div style={{ flex: "0 0 118px" }}>
            <div style={label}>{t("schedule.reminder")}</div>
            <Dropdown
              value={form.reminder}
              options={reminderOptions}
              onChange={(v) => patchForm({ reminder: v })}
              t={tOption}
              ariaLabel={t("schedule.reminder")}
            />
          </div>
          <div className="flex-1" />
          <Switch
            checked={form.alarm}
            onChange={(v) => patchForm({ alarm: v })}
            label={form.alarm ? t("schedule.alarm.on") : t("schedule.alarm.off")}
            isDark={isDark}
          />
        </div>

        {/* 自定义提醒：选「自定义」才出现，数值 + 单位按 1-60 分 / 1-24 时 / 1-30 天夹取值 */}
        {form.reminder === CUSTOM_REMINDER && (
          <div className="flex items-center" style={{ gap: 6, marginBottom: 6 }}>
            <div style={label}>{t("schedule.reminder.customLabel")}</div>
            <input
              type="number"
              min={1}
              max={REMINDER_UNITS[form.reminderUnit].max}
              value={form.reminderValue}
              onChange={(e) => patchForm({ reminderValue: e.target.value })}
              onBlur={() =>
                patchForm({ reminderValue: String(clampReminderValue(form.reminderValue, form.reminderUnit)) })
              }
              style={{ ...field, flex: "0 0 62px", textAlign: "center" }}
            />
            <div style={{ flex: "0 0 92px" }}>
              <Dropdown
                value={form.reminderUnit}
                options={REMINDER_UNIT_OPTIONS}
                onChange={(unit) =>
                  patchForm({
                    reminderUnit: unit,
                    reminderValue: String(clampReminderValue(form.reminderValue, unit)),
                  })
                }
                t={t}
                ariaLabel={t("schedule.reminder.customLabel")}
              />
            </div>
            <span className="text-[10px] opacity-45">
              {t("schedule.reminder.customRange", { max: REMINDER_UNITS[form.reminderUnit].max })}
            </span>
          </div>
        )}

        {/* 地点 / 备注 */}
        <div className="flex items-center" style={{ gap: 6, marginBottom: 6 }}>
          <input
            value={form.location}
            onChange={(e) => patchForm({ location: e.target.value })}
            placeholder={t("schedule.locationPlaceholder")}
            style={{ ...field, flex: "1 1 50%" }}
          />
          <input
            value={form.notes}
            onChange={(e) => patchForm({ notes: e.target.value })}
            placeholder={t("schedule.notesPlaceholder")}
            style={{ ...field, flex: "1 1 50%" }}
          />
        </div>

        {/* 重复日程的改动范围 */}
        {isSeries && (
          <div className="flex items-center" style={{ gap: 6, marginBottom: 4 }}>
            <span className="text-[9.5px] shrink-0" style={{ color: "var(--island-text-muted)" }}>
              {t("schedule.scope.hint")}
            </span>
            <div className="flex" style={{ gap: 4 }}>
              {(
                [
                  ["this", "schedule.scope.this"],
                  ["all", "schedule.scope.all"],
                  ["reset", "schedule.scope.reset"],
                ] as const
              ).map(([key, labelKey]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScope(key)}
                  className="text-[10px] cursor-pointer"
                  style={{
                    padding: "3px 7px",
                    borderRadius: 6,
                    border: "1px solid var(--island-border)",
                    background: scope === key ? "rgba(10,132,255,0.26)" : "transparent",
                    color: scope === key ? "var(--island-text)" : "var(--island-text-muted)",
                    lineHeight: 1.2,
                  }}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="text-[10px]" style={{ color: "#ff6b6b", paddingTop: 2 }}>
            {error === "title" ? t("schedule.error.title") : t("schedule.error.end")}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: "6px 14px 10px", gap: 8 }}
      >
        {occurrence ? (
          <button
            type="button"
            onClick={remove}
            className="text-[10.5px] cursor-pointer"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: confirmDelete ? "#ff6b6b" : "var(--island-text-muted)",
              fontWeight: confirmDelete ? 600 : 400,
            }}
          >
            {confirmDelete
              ? t("schedule.confirm")
              : isSeries && scope === "this"
                ? t("schedule.deleteOne")
                : isSeries
                  ? t("schedule.deleteAll")
                  : t("schedule.delete")}
          </button>
        ) : (
          <span />
        )}

        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            className="text-[10.5px] cursor-pointer"
            style={{
              background: "none",
              border: "none",
              padding: "4px 8px",
              color: "var(--island-text-muted)",
            }}
          >
            {t("schedule.cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            className="text-[10.5px] cursor-pointer"
            style={{
              padding: "4px 14px",
              borderRadius: 7,
              border: "1px solid var(--island-border)",
              background: "rgba(10,132,255,0.85)",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            {t("schedule.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 「仅本次」的差异补丁：只写与系列默认值不同的字段。
 * 不改标题/时间就不要往 exceptions 里塞空 patch —— 那会让月历上多一个「已调整」。
 */
function seriesPatch(
  event: Occurrence["event"],
  occurrenceDate: string,
  next: {
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    location: string;
    notes: string;
    reminderMinutes: number | null;
    alarmEnabled: boolean;
  }
): EventPatch {
  const patch: EventPatch = {};
  if (next.title !== event.title) patch.title = next.title;
  if (next.allDay !== event.allDay) patch.allDay = next.allDay;

  const expectedStart = event.allDay
    ? `${occurrenceDate}T00:00`
    : `${occurrenceDate}T${event.start.slice(11, 16)}`;
  const expectedEnd = event.allDay
    ? `${occurrenceDate}T00:00`
    : `${occurrenceDate}T${event.end.slice(11, 16)}`;
  if (next.start !== expectedStart) patch.start = next.start;
  if (next.end !== expectedEnd) patch.end = next.end;

  if (next.location !== (event.location ?? "")) patch.location = next.location;
  if (next.notes !== (event.notes ?? "")) patch.notes = next.notes;
  if (next.reminderMinutes !== event.reminderMinutes) {
    patch.reminderMinutes = next.reminderMinutes;
  }
  if (next.alarmEnabled !== event.alarmEnabled) patch.alarmEnabled = next.alarmEnabled;
  return patch;
}

/** 小开关：18px 高，比 12px 文字高一点，点得住 */
function Switch({
  checked,
  onChange,
  label,
  isDark,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  isDark: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center shrink-0 cursor-pointer"
      style={{ gap: 5, background: "none", border: "none", padding: 0 }}
    >
      <span
        style={{
          width: 26,
          height: 15,
          borderRadius: 8,
          flexShrink: 0,
          background: checked
            ? "rgba(10,132,255,0.85)"
            : isDark
              ? "rgba(255,255,255,0.16)"
              : "rgba(0,0,0,0.16)",
          position: "relative",
          transition: "background-color 140ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 140ms ease",
          }}
        />
      </span>
      <span className="text-[9.5px] whitespace-nowrap" style={{ color: "var(--island-text-muted)" }}>
        {label}
      </span>
    </button>
  );
}
