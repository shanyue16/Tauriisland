import { useMemo, useState } from "react";
import { useSettings } from "../../stores/settings";
import { fetchNotifications } from "../../services/notifications";
import { sendNotification } from "../../services/notify";

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

export default function NotificationSettings() {
  const { settings, updateSettings } = useSettings();
  const list = settings.notificationBlacklist ?? [];

  const [input, setInput] = useState("");
  const [hint, setHint] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [candidates, setCandidates] = useState<{ appId: string; appName: string }[] | null>(null);
  const [sending, setSending] = useState(false);

  const exists = (name: string) => list.some((e) => e.toLowerCase() === name.toLowerCase());

  const addEntry = (raw: string): boolean => {
    const name = raw.trim();
    if (!name) {
      setHint({ text: "请输入应用标识或显示名", tone: "warn" });
      return false;
    }
    if (exists(name)) {
      setHint({ text: `「${name}」已在黑名单中`, tone: "warn" });
      return false;
    }
    updateSettings({ notificationBlacklist: [...list, name] });
    setHint({ text: `已加入黑名单：${name}`, tone: "ok" });
    return true;
  };

  const removeEntry = (name: string) => {
    updateSettings({ notificationBlacklist: list.filter((e) => e !== name) });
    setHint({ text: `已移出黑名单：${name}`, tone: "ok" });
  };

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
        setHint({ text: "当前没有可选取的通知应用", tone: "warn" });
        return;
      }
      setCandidates(found);
    } catch {
      setHint({ text: "读取通知失败", tone: "warn" });
    } finally {
      setDetecting(false);
    }
  };

  /** 发一条测试通知，验证发送链路（Phase C） */
  const handleTestNotify = async () => {
    if (sending) return;
    setSending(true);
    setHint(null);
    const ok = await sendNotification({
      title: "Tauriisland 测试通知",
      body: "如果你看到这条通知，说明发送链路正常。",
    });
    setSending(false);
    setHint(
      ok
        ? { text: "已发送。没看到请检查专注助手 / 请勿打扰。", tone: "ok" }
        : { text: "发送失败：请查看应用日志。", tone: "warn" }
    );
  };

  const btnStyle: React.CSSProperties = useMemo(
    () => ({
      fontSize: 11,
      lineHeight: 1,
      padding: "7px 12px",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.08)",
      color: "var(--island-text)",
      cursor: "pointer",
      whiteSpace: "nowrap",
    }),
    []
  );

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">通知</h3>

      {/* ① 读取 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <span className="text-[12px] font-medium">读取系统通知</span>
        <ToggleRow
          label="读取通知"
          hint="读取的是系统通知中心里的全部通知（只读，不修改、不撤回）"
          value={settings.notificationsEnabled}
          onChange={(v) => updateSettings({ notificationsEnabled: v })}
        />
        <div>
          <div className="flex justify-between text-[11px] mb-1.5">
            <span className="opacity-60">刷新间隔</span>
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
            <span className="opacity-60">最多显示</span>
            <span className="tabular-nums">{settings.notificationMaxItems} 条</span>
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
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <span className="text-[12px] font-medium">新通知提醒</span>
        <ToggleRow
          label="弹出提醒"
          hint="有新通知时短暂展开岛显示内容；已在展开态/设置面板时不打扰"
          value={settings.notificationAlert}
          onChange={(v) => updateSettings({ notificationAlert: v })}
        />
        {settings.notificationAlert && (
          <div>
            <div className="flex justify-between text-[11px] mb-1.5">
              <span className="opacity-60">停留时长</span>
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
              鼠标移到提醒上时不会自动收起，移开后重新计时。
            </div>
          </div>
        )}
      </div>

      {/* ② 黑名单 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">不读取的应用</span>
          <span className="text-[11px] opacity-50">{list.length} 项</span>
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          命中这些关键词的应用不会被显示（忽略大小写、包含匹配）。
          匹配应用标识（如 QQ）或显示名均可。为空表示不过滤、显示全部。
        </div>

        {list.length === 0 ? (
          <div className="text-[11px] opacity-45">黑名单为空：当前显示全部应用的通知。</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {list.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 text-[11px] leading-none"
                style={{
                  padding: "5px 6px 5px 9px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <span className="truncate" style={{ maxWidth: 150 }}>
                  {name}
                </span>
                <button
                  type="button"
                  title={`移除 ${name}`}
                  onClick={() => removeEntry(name)}
                  className="flex items-center justify-center cursor-pointer"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: "none",
                    background: "rgba(255,255,255,0.14)",
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
            placeholder="输入应用标识或名称（如 QQ）"
            onKeyDown={(e) => {
              if (e.key === "Enter" && addEntry(input)) setInput("");
            }}
            className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none min-w-0"
            style={{
              background: "rgba(0,0,0,0.2)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--island-text)",
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (addEntry(input)) setInput("");
            }}
            style={btnStyle}
          >
            添加
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleDetect()}
          disabled={detecting}
          style={{ ...btnStyle, opacity: detecting ? 0.55 : 1 }}
        >
          {detecting ? "读取中…" : "从当前通知中选取"}
        </button>

        {candidates && (
          <div className="space-y-1">
            <div className="text-[10px] opacity-50">点击加入黑名单：</div>
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
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "var(--island-text)",
                    opacity: exists(c.appId) ? 0.4 : 1,
                  }}
                  title={c.appId}
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
            style={{ color: hint.tone === "ok" ? "#5aa9ff" : "rgba(255,255,255,0.6)" }}
          >
            {hint.text}
          </div>
        )}
      </div>

      {/* ③ 发送 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <span className="text-[12px] font-medium">发送通知</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          由本应用向系统发送通知。开发模式下通知归属的应用身份可能显示不准，
          安装版正常。
        </div>
        <button
          type="button"
          onClick={() => void handleTestNotify()}
          disabled={sending}
          style={{ ...btnStyle, opacity: sending ? 0.55 : 1 }}
        >
          测试通知
        </button>
        <ToggleRow
          label="日程 / 闹钟通知"
          hint="日程模块接入后生效（当前没有触发器）"
          value={settings.notifyOnAlarm}
          onChange={(v) => updateSettings({ notifyOnAlarm: v })}
        />
      </div>
    </div>
  );
}
