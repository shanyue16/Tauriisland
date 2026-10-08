import { useSettings } from "../../stores/settings";
import type { AnimationSpeed } from "../../types";

const SPEEDS: { key: AnimationSpeed; label: string }[] = [
  { key: "slow", label: "慢" },
  { key: "normal", label: "正常" },
  { key: "fast", label: "快" },
];

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
    <div className="flex items-center justify-between py-1">
      <span className="text-[11px] opacity-80">{label}</span>
      <div
        className={`switch${value ? " active" : ""}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}

export default function InteractionSettings() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">交互</h3>

      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">悬停展开延迟</span>
          <span className="tabular-nums">{settings.hoverDelay}ms</span>
        </div>
        <input
          type="range"
          min={0}
          max={500}
          step={50}
          value={settings.hoverDelay}
          onChange={(e) =>
            updateSettings({ hoverDelay: Number(e.target.value) })
          }
        />
      </div>

      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">失焦收起延迟</span>
          <span className="tabular-nums">{settings.collapseDelay}ms</span>
        </div>
        <input
          type="range"
          min={500}
          max={5000}
          step={100}
          value={settings.collapseDelay}
          onChange={(e) =>
            updateSettings({ collapseDelay: Number(e.target.value) })
          }
        />
      </div>

      <div>
        <div className="text-[11px] opacity-60 mb-2">动画速度</div>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s.key}
              onClick={() => updateSettings({ animationSpeed: s.key })}
              className="flex-1 py-1.5 rounded-md text-[11px]"
              style={{
                background:
                  settings.animationSpeed === s.key
                    ? "rgba(255,255,255,0.18)"
                    : "rgba(255,255,255,0.05)",
                cursor: "pointer",
                border: "none",
                color: "#fff",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        label="滚轮翻页"
        value={settings.wheelEnabled}
        onChange={(v) => updateSettings({ wheelEnabled: v })}
      />
      <Toggle
        label="最小态点击穿透"
        value={settings.clickThroughMinimal}
        onChange={(v) => updateSettings({ clickThroughMinimal: v })}
      />
    </div>
  );
}
