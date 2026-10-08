import { useSettings } from "../../stores/settings";

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] opacity-80">{label}</span>
      <div
        className={`switch${value ? " active" : ""}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}

export default function AdvancedSettings() {
  const { settings, updateSettings, resetSettings } = useSettings();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">高级</h3>

      <Toggle
        label="开机自启动"
        value={settings.autoStart}
        onChange={(v) => updateSettings({ autoStart: v })}
      />
      <Toggle
        label="调试模式"
        value={settings.debugMode}
        onChange={(v) => updateSettings({ debugMode: v })}
      />

      <button
        onClick={resetSettings}
        className="w-full py-2 rounded-lg text-[11px] transition-all"
        style={{
          background: "rgba(239, 68, 68, 0.15)",
          color: "#fca5a5",
          border: "1px solid rgba(239, 68, 68, 0.3)",
          cursor: "pointer",
        }}
      >
        重置所有设置
      </button>
    </div>
  );
}
