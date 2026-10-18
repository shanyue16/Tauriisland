import { useMemo, useRef, useState } from "react";
import Dropdown from "./Dropdown";
import { BTN_STYLE, FIELD_STYLE } from "./styles";
import { useNameList } from "./useNameList";
import { MAX_CUSTOM_SOUND_ITEMS, useSettings } from "../../stores/settings";
import { toMeta, useCustomSounds } from "../../stores/customSounds";
import { useI18n } from "../../i18n";
import { fetchNotifications } from "../../services/notifications";
import { sendNotification } from "../../services/notify";
import {
  ALARM_SOUNDS,
  NOTIFICATION_SOUNDS,
  newCustomSoundId,
  previewSound,
  previewSoundSrc,
  readSoundFile,
  type SoundOption,
} from "../../services/audio";
import type { CustomSound, Settings } from "../../types";

/**
 * 通知设置。
 *
 * 三段：读取开关 / 不读取的应用（黑名单）/ 发送（测试通知 + 闹钟预留开关）。
 * 黑名单是**反向**语义：为空表示不过滤（默认全读），与"歌曲"页的白名单相反。
 */
function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="text-[11px] opacity-80">{label}</div>
        {hint && <div className="text-[10px] opacity-45 leading-relaxed mt-0.5">{hint}</div>}
      </div>
      <div
        className={`switch shrink-0${value ? " active" : ""}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}

/**
 * 音效选择器（通知音 / 闹钟音共用）。
 *
 * 取值三态：`none`（静音）/ 内置音 id / `custom`（用户上传的 data URL）。
 * 自定义音频直接以 data URL 存进 settings.json —— 不落盘到磁盘目录、不需要 fs 权限，
 * 上传上限 400KB 由 `readSoundFile` 把关（见 src/services/audio.ts）。
 */
const ADD_SOUND = "#add-custom";

/**
 * 音效选择器（通知音 / 闹钟音共用）。
 *
 * 取值四态：`none`（静音）/ 内置音 id / 自定义音效库里某条的 id / `ADD_SOUND`（触发上传）。
 * 自定义音效支持**多条并存**：上传即入库，下拉里逐条可选，下方列表可逐条试听与删除。
 * 音频以 data URL 存 settings.json（上限见 audio.ts 的 MAX_CUSTOM_BYTES），不落盘、免 fs 权限。
 */
function SoundPicker({ kind }: { kind: "notification" | "alarm" }) {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 音频本体在 sounds.json（store 里带 data），settings 里只有元数据
  const sounds = useCustomSounds((s) => s.sounds);
  const addSound = useCustomSounds((s) => s.add);
  const dropSound = useCustomSounds((s) => s.remove);

  const isAlarm = kind === "alarm";
  const list: SoundOption[] = isAlarm ? ALARM_SOUNDS : NOTIFICATION_SOUNDS;
  const value = isAlarm ? settings.alarmSound : settings.notificationSound;
  const mine = settings.customSounds.filter((s) => s.kind === kind);
  // 试听要音频本体，本体在 sounds store 里（settings 只有元数据）
  const dataById = useMemo(() => new Map(sounds.map((s) => [s.id, s.data])), [sounds]);

  const options = useMemo(
    () => [
      { key: "none", labelKey: "settings.notification.soundNone" },
      ...list.map((o) => ({ key: o.id, labelKey: `settings.notification.sound.${o.id}` })),
      ...mine.map((s) => ({ key: s.id, labelKey: `#custom:${s.id}:${s.name || s.id}` })),
      { key: ADD_SOUND, labelKey: "settings.notification.soundAddCustom" },
    ],
    [list, mine]
  );

  const label = (key: string) => {
    if (key === ADD_SOUND) return t("settings.notification.soundAddCustom");
    if (key.startsWith("#custom:")) {
      // 形如 #custom:<id>:<名字>，只取名字部分
      return key.split(":").slice(2).join(":") || t("settings.notification.soundCustomFallback");
    }
    return t(key);
  };

  const setSound = (next: string) =>
    updateSettings(isAlarm ? { alarmSound: next } : { notificationSound: next });

  const handlePick = async (file: File | null) => {
    if (!file) return;
    if (settings.customSounds.length >= MAX_CUSTOM_SOUND_ITEMS) {
      setNote(t("settings.notification.soundLimit", { max: MAX_CUSTOM_SOUND_ITEMS }));
      return;
    }
    const dataUrl = await readSoundFile(file);
    if (!dataUrl) {
      setNote(t("settings.notification.soundTooLarge"));
      return;
    }
    const id = newCustomSoundId();
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
    const entry: CustomSound = { id, name, kind, data: dataUrl, size: file.size };
    // 音频本体进 sounds.json，settings 只留元数据（id/名字/体积）
    addSound(entry);
    const nextMeta = [...settings.customSounds, toMeta(entry)];
    setNote(t("settings.notification.soundCustomSet", { size: `${Math.max(1, Math.round(file.size / 1024))} KB` }));
    updateSettings(
      isAlarm
        ? { customSounds: nextMeta, alarmSound: id }
        : { customSounds: nextMeta, notificationSound: id }
    );
  };

  /** 删除一条自定义音；正被选中就回退默认音，避免"选着一个不存在的音" */
  const removeSound = (id: string) => {
    dropSound(id);
    const nextMeta = settings.customSounds.filter((s) => s.id !== id);
    const patch: Partial<Settings> = { customSounds: nextMeta };
    if (settings.notificationSound === id) patch.notificationSound = "prompt-short";
    if (settings.alarmSound === id) patch.alarmSound = "clock-ringing";
    updateSettings(patch);
    setNote(null);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] opacity-80 shrink-0" style={{ width: 64 }}>
          {isAlarm ? t("settings.notification.soundAlarm") : t("settings.notification.soundNotify")}
        </span>
        <div className="flex-1 min-w-0">
          <Dropdown
            value={value}
            options={options}
            onChange={(next) => {
              if (next === ADD_SOUND) {
                inputRef.current?.click();
                return;
              }
              setSound(next);
              setNote(null);
            }}
            t={label}
            ariaLabel={
              isAlarm ? t("settings.notification.soundAlarm") : t("settings.notification.soundNotify")
            }
          />
        </div>
        <button
          type="button"
          onClick={() => previewSound(kind)}
          className="text-[11px] leading-none cursor-pointer shrink-0"
          style={{
            padding: "6px 9px",
            borderRadius: 7,
            border: "1px solid var(--island-border)",
            background: "var(--surface-2)",
            color: "var(--island-text)",
            whiteSpace: "nowrap",
          }}
        >
          {t("settings.notification.soundPreview")}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = "";
          void handlePick(file);
        }}
      />

      {mine.length > 0 && (
        <div className="space-y-1 pl-[72px]">
          {mine.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="text-[10px] opacity-60 truncate flex-1 min-w-0">
                {s.name || t("settings.notification.soundCustomFallback")}
                {s.size > 0 && ` · ${Math.max(1, Math.round(s.size / 1024))}KB`}
              </span>
              <button
                type="button"
                onClick={() => {
                  const dataUrl = dataById.get(s.id);
                  if (dataUrl) previewSoundSrc(dataUrl);
                }}
                className="text-[10px] leading-none cursor-pointer opacity-70 hover:opacity-100 shrink-0"
                style={{ border: "none", background: "transparent", color: "var(--island-text)" }}
              >
                {t("settings.notification.soundPreview")}
              </button>
              <button
                type="button"
                onClick={() => removeSound(s.id)}
                aria-label={t("settings.notification.soundDelete")}
                className="text-[10px] leading-none cursor-pointer opacity-70 hover:opacity-100 shrink-0"
                style={{ border: "none", background: "transparent", color: "#ff6b6b" }}
              >
                {t("settings.notification.soundDelete")}
              </button>
            </div>
          ))}
        </div>
      )}

      {note && <div className="text-[10px] text-[#4ade80] pl-[72px]">{note}</div>}
    </div>
  );
}

export default function NotificationSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const list = settings.notificationBlacklist ?? [];

  const [input, setInput] = useState("");
  /** 测试通知的提示单独一份：它属于③卡片，混用②的 hint 会显示在上面的黑名单卡里看不见 */
  const [testHint, setTestHint] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [candidates, setCandidates] = useState<{ appId: string; appName: string }[] | null>(null);
  const [sending, setSending] = useState(false);

  const { hint, setHint, exists, addEntry, removeEntry } = useNameList({
    list,
    commit: (next) => updateSettings({ notificationBlacklist: next }),
    keys: {
      empty: "settings.notification.emptyInput",
      exists: "settings.notification.alreadyInBlacklist",
      added: "settings.notification.added",
      removed: "settings.notification.removed",
    },
  });

  /** 从当前系统通知里列出出现过的应用，供勾选（手敲包标识不现实） */
  const handleDetect = async () => {
    if (detecting) return;
    setDetecting(true);
    setHint(null);
    setCandidates(null);
    try {
      const items = await fetchNotifications(50);
      const map = new Map<string, string>();
      for (const it of items) {
        const key = it.appId || it.appName;
        if (key && !map.has(key)) map.set(key, it.appName);
      }
      const found = [...map.entries()].map(([appId, appName]) => ({ appId, appName }));
      if (found.length === 0) {
        setHint({ text: t("settings.notification.detectNone"), tone: "warn" });
        return;
      }
      setCandidates(found);
    } catch {
      setHint({ text: t("settings.notification.detectFail"), tone: "warn" });
    } finally {
      setDetecting(false);
    }
  };

  /** 发一条测试通知，验证发送链路（Phase C） */
  const handleTestNotify = async () => {
    if (sending) return;
    if (!settings.systemNotification) {
      setTestHint({ text: t("settings.notification.testDisabled"), tone: "warn" });
      return;
    }
    setSending(true);
    setTestHint(null);
    const ok = await sendNotification({
      title: t("settings.notification.testTitle"),
      body: t("settings.notification.testBody"),
    });
    setSending(false);
    setTestHint(
      ok
        ? { text: t("settings.notification.testSent"), tone: "ok" }
        : { text: t("settings.notification.testFail"), tone: "warn" }
    );
  };

  const btnStyle = BTN_STYLE;

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">{t("settings.notification.title")}</h3>

      {/* ① 读取 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <span className="text-[12px] font-medium">{t("settings.notification.readTitle")}</span>
        <ToggleRow
          label={t("settings.notification.readLabel")}
          hint={t("settings.notification.readHint")}
          value={settings.notificationsEnabled}
          onChange={(v) => updateSettings({ notificationsEnabled: v })}
        />
        <div>
          <div className="flex justify-between text-[11px] mb-1.5">
            <span className="opacity-60">{t("settings.notification.poll")}</span>
            <span className="tabular-nums">{settings.notificationPollMs / 1000}s</span>
          </div>
          <input
            type="range"
            min={5000}
            max={60000}
            step={5000}
            value={settings.notificationPollMs}
            onChange={(e) => updateSettings({ notificationPollMs: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className="flex justify-between text-[11px] mb-1.5">
            <span className="opacity-60">{t("settings.notification.maxItems")}</span>
            <span className="tabular-nums">{t("settings.notification.maxCount", { count: settings.notificationMaxItems })}</span>
          </div>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={settings.notificationMaxItems}
            onChange={(e) => updateSettings({ notificationMaxItems: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* ①.5 新通知提醒 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <span className="text-[12px] font-medium">{t("settings.notification.alertTitle")}</span>
        <ToggleRow
          label={t("settings.notification.alertLabel")}
          hint={t("settings.notification.alertHint")}
          value={settings.notificationAlert}
          onChange={(v) => updateSettings({ notificationAlert: v })}
        />
        {settings.notificationAlert && (
          <div>
            <div className="flex justify-between text-[11px] mb-1.5">
              <span className="opacity-60">{t("settings.notification.alertDuration")}</span>
              <span className="tabular-nums">{(settings.notificationAlertMs / 1000).toFixed(1)}s</span>
            </div>
            <input
              type="range"
              min={2000}
              max={15000}
              step={500}
              value={settings.notificationAlertMs}
              onChange={(e) => updateSettings({ notificationAlertMs: Number(e.target.value) })}
            />
            <div className="text-[10px] opacity-45 leading-relaxed mt-1">
              {t("settings.notification.alertDurationHint")}
            </div>
          </div>
        )}
      </div>

      {/* ①.6 音效：通知音 / 闹钟音，各可试听与自定义 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <span className="text-[12px] font-medium">{t("settings.notification.soundTitle")}</span>
        <div className="text-[10px] opacity-45 leading-relaxed">
          {t("settings.notification.soundHint")}
        </div>
        <SoundPicker kind="notification" />
        <SoundPicker kind="alarm" />
      </div>

      {/* ② 黑名单 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t("settings.notification.blacklistTitle")}</span>
          <span className="text-[11px] opacity-50">{t("common.countItems", { count: list.length })}</span>
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.notification.blacklistHint")}
        </div>

        {list.length === 0 ? (
          <div className="text-[11px] opacity-45">{t("settings.notification.blacklistEmpty")}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {list.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 text-[11px] leading-none"
                style={{
                  padding: "5px 6px 5px 9px",
                  borderRadius: 999,
                  background: "var(--surface-2)",
                  border: "1px solid var(--island-border)",
                }}
              >
                <span className="truncate" style={{ maxWidth: 150 }}>
                  {name}
                </span>
                <button
                  type="button"
                  aria-label={t("common.removeName", { name })}
                  data-tip={t("common.removeName", { name })}
                  onClick={() => removeEntry(name)}
                  className="flex items-center justify-center cursor-pointer"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: "none",
                    background: "var(--surface-3)",
                    color: "var(--island-text)",
                    fontSize: 10,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("settings.notification.inputPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && addEntry(input)) setInput("");
            }}
            className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none min-w-0"
            style={FIELD_STYLE}
          />
          <button
            type="button"
            onClick={() => {
              if (addEntry(input)) setInput("");
            }}
            style={btnStyle}
          >
            {t("common.add")}
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleDetect()}
          disabled={detecting}
          style={{ ...btnStyle, opacity: detecting ? 0.55 : 1 }}
        >
          {detecting ? t("common.reading") : t("settings.notification.detect")}
        </button>

        {candidates && (
          <div className="space-y-1">
            <div className="text-[10px] opacity-50">{t("settings.notification.pickHint")}</div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((c) => (
                <button
                  key={c.appId}
                  type="button"
                  onClick={() => addEntry(c.appId)}
                  className="text-[11px] leading-none cursor-pointer truncate"
                  style={{
                    maxWidth: 200,
                    padding: "5px 9px",
                    borderRadius: 999,
                    background: "var(--surface-1)",
                    border: "1px solid var(--island-border)",
                    color: "var(--island-text)",
                    opacity: exists(c.appId) ? 0.4 : 1,
                  }}
                  data-tip={c.appId}
                >
                  {c.appName}
                </button>
              ))}
            </div>
          </div>
        )}

        {hint && (
          <div
            className="text-[11px]"
            style={{ color: hint.tone === "ok" ? "var(--state-info)" : "var(--island-text-muted)" }}
          >
            {hint.text}
          </div>
        )}
      </div>

      {/* ③ 发送 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <span className="text-[12px] font-medium">{t("settings.notification.sendTitle")}</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.notification.sendHint")}
        </div>
        <ToggleRow
          label={t("settings.notification.systemLabel")}
          hint={t("settings.notification.systemHint")}
          value={settings.systemNotification}
          onChange={(v) => updateSettings({ systemNotification: v })}
        />
        <button
          type="button"
          onClick={() => void handleTestNotify()}
          disabled={sending}
          style={{ ...btnStyle, opacity: sending ? 0.55 : 1 }}
        >
          {t("settings.notification.test")}
        </button>
        {testHint && (
          <div
            className="text-[11px] leading-relaxed"
            style={{ color: testHint.tone === "ok" ? "var(--state-info)" : "#ff6b6b" }}
          >
            {testHint.text}
          </div>
        )}
        <ToggleRow
          label={t("settings.notification.alarm")}
          hint={t("settings.notification.alarmHint")}
          value={settings.notifyOnAlarm}
          onChange={(v) => updateSettings({ notifyOnAlarm: v })}
        />
      </div>
    </div>
  );
}
