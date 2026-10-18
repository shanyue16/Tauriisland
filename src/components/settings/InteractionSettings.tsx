import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import { ANIMATION_DURATION, type AnimationSpeed } from "../../types";
import Toggle from "./Toggle";

const SPEEDS: { key: AnimationSpeed; labelKey: string }[] = [
  { key: "slow", labelKey: "settings.interaction.speedSlow" },
  { key: "normal", labelKey: "settings.interaction.speedNormal" },
  { key: "fast", labelKey: "settings.interaction.speedFast" },
];


export default function InteractionSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.interaction.title")}</h3>

      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.interaction.hoverDelay")}</span>
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
          <span className="opacity-60">{t("settings.interaction.collapseDelay")}</span>
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
        <div className="flex justify-between text-[11px] mb-2">
          <span className="opacity-60">{t("settings.interaction.animationSpeed")}</span>
          {/* 三挡的基准时长直接来自 ANIMATION_DURATION，和动效实际取时长是同一个源 */}
          <span className="tabular-nums">
            {ANIMATION_DURATION[settings.animationSpeed]}ms
          </span>
        </div>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s.key}
              onClick={() => updateSettings({ animationSpeed: s.key })}
              className="flex-1 py-1.5 rounded-md text-[11px]"
              style={{
                background:
                  settings.animationSpeed === s.key
                    ? "var(--surface-3)"
                    : "var(--surface-1)",
                cursor: "pointer",
                border: "none",
                color: "var(--island-text)",
              }}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        dense
        label={t("settings.interaction.wheel")}
        value={settings.wheelEnabled}
        onChange={(v) => updateSettings({ wheelEnabled: v })}
      />
      <Toggle
        dense
        label={t("settings.interaction.clickThrough")}
        value={settings.clickThroughMinimal}
        onChange={(v) => updateSettings({ clickThroughMinimal: v })}
      />
    </div>
  );
}
