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

export default function MonitorSettings() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">显示器</h3>

      <Toggle
        label="多显示器支持"
        value={settings.multiMonitor}
        onChange={(v) => updateSettings({ multiMonitor: v })}
      />
      <Toggle
        label="DPI 感知（高分辨率屏幕自动缩放）"
        value={settings.dpiAware}
        onChange={(v) => updateSettings({ dpiAware: v })}
      />
    </div>
  );
}
