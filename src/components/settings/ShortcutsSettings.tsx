import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";

type HotkeyField = "hotkeyQuit" | "hotkeyToggle";

/**
 * 把一次按键事件组合成规范键位文本（如 "Alt+Shift+Z"）。
 *
 * 用 `e.code`（物理键位）而不是 `e.key`（随键盘布局/输入法变），保证
 * Alt+Z 在任何布局下都记作 "Alt+Z"。只认 A-Z / 0-9 / F1-F12（与 Rust
 * hotkeys.rs parse_combo 同一集合），且要求至少一个修饰键 —— 裸主键
 * 会被 RegisterHotKey 全局劫持，用户连字都打不了。
 * 不合法返回 null（继续等下一次按键）。
 */
function comboFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.altKey) mods.push("Alt");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit([0-9])$/.exec(e.code);
  const fn = /^F([1-9]|1[0-2])$/.exec(e.code);
  const main = letter?.[1] ?? digit?.[1] ?? fn?.[0] ?? null;
  if (!main || mods.length === 0) return null;
  return [...mods, main].join("+");
}

export default function ShortcutsSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const [recording, setRecording] = useState<HotkeyField | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 始终指向最新设置：录制结束恢复注册时要用当前值（闭包里的 settings 会旧）。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 进本页时用当前键位重推一遍注册：注册失败只在注册瞬间发一次 hotkey://error，
  // 启动时那次失败没人听见 —— 重推一遍把错误拉到本页的监听期间显示出来。
  // 改键后的重注册由 Island 的 effect 负责，这里只在挂载时补一次。
  useEffect(() => {
    void invoke("set_hotkeys", {
      quit: settings.hotkeyQuit,
      toggle: settings.hotkeyToggle,
    }).catch(() => {
      /* 命令不可用（旧构建）时无全局快捷键 */
    });
  }, []);

  useEffect(() => {
    let unlistenErr: (() => void) | undefined;
    let unlistenOk: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("hotkey://error", (e) => setError(String(e.payload ?? "")))
      .then((fn) => {
        if (cancelled) fn();
        else unlistenErr = fn;
      })
      .catch(() => {
        /* 事件系统不可用时退化为"看不到注册错误"，不影响录制 */
      });
    // 两键都注册成功的回执：把旧错误清掉（改键成功后不应残留上次的红条）
    void listen("hotkey://registered", () => setError(null))
      .then((fn) => {
        if (cancelled) fn();
        else unlistenOk = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlistenErr?.();
      unlistenOk?.();
    };
  }, []);

  // 录制期间先卸掉全局热键：WM_HOTKEY 是系统级的，DOM keydown 拦不住——
  // 不卸的话用户按下 Alt+Z 录制新键时旧热键会先触发（直接退出应用）。
  // 依赖用 recording !== null 而不是 recording 本身：从框 A 切到框 B 时
  // 不能一卸一装（IPC 乱序可能把热键提前装回来），保持挂起即可。
  const recordingActive = recording !== null;
  useEffect(() => {
    if (!recordingActive) return;
    void invoke("set_hotkeys", { quit: "", toggle: "" }).catch(() => {});
    return () => {
      const s = settingsRef.current;
      void invoke("set_hotkeys", { quit: s.hotkeyQuit, toggle: s.hotkeyToggle }).catch(() => {});
    };
  }, [recordingActive]);

  // 录制中的按键采集：捕获阶段拦截，先于岛内翻页/表单的 keydown 处理，
  // 避免按方向键选键时顺带翻了页。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      // 录新键后旧错误已过时：先清掉，注册若再失败会由新事件补上
      setError(null);
      if (recording === "hotkeyQuit") updateSettings({ hotkeyQuit: combo });
      else updateSettings({ hotkeyToggle: combo });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, updateSettings]);

  const rows: { field: HotkeyField; label: string }[] = [
    { field: "hotkeyQuit", label: t("settings.shortcuts.quit") },
    { field: "hotkeyToggle", label: t("settings.shortcuts.toggle") },
  ];

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.shortcuts.title")}</h3>

      <div>
        {rows.map(({ field, label }) => (
          <div key={field} className="flex items-center justify-between py-1.5">
            <span className="text-[11px] opacity-80">{label}</span>
            <button
              onClick={() => {
                setError(null);
                setRecording(recording === field ? null : field);
              }}
              className="px-3 py-1.5 rounded-lg text-[11px] transition-all"
              style={{
                minWidth: 104,
                background:
                  recording === field ? "rgba(99, 102, 241, 0.18)" : "rgba(255, 255, 255, 0.06)",
                border: `1px solid ${
                  recording === field ? "rgba(99, 102, 241, 0.5)" : "rgba(255, 255, 255, 0.12)"
                }`,
                color: "inherit",
                cursor: "pointer",
              }}
            >
              {recording === field ? t("settings.shortcuts.recording") : settings[field]}
            </button>
          </div>
        ))}
      </div>

      <p className="text-[10px] opacity-60 leading-relaxed">{t("settings.shortcuts.hint")}</p>

      {error && (
        <div
          className="px-3 py-2 rounded-lg text-[11px]"
          style={{
            background: "rgba(239, 68, 68, 0.15)",
            color: "#fca5a5",
            border: "1px solid rgba(239, 68, 68, 0.3)",
          }}
        >
          <div className="font-semibold mb-1">{t("settings.shortcuts.errorTitle")}</div>
          <div>{error}</div>
        </div>
      )}
    </div>
  );
}
