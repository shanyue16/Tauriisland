import { useSettings } from "../../stores/settings";
import type { ThemeType } from "../../types";
import { THEME_PRESETS } from "../../types";

// 说明：岛样式（悬浮胶囊/贴边挂角）与水平位置已挪到「位置」页（PositionSettings），
// 本页只留与"摆在哪"无关的外观项：主题、圆角、透明度、宽度。

const THEMES: { key: ThemeType; label: string }[] = [
  { key: "dark", label: "暗色" },
  { key: "light", label: "亮色" },
];

export default function AppearanceSettings() {
  const { settings, updateSettings } = useSettings();
  const theme = THEME_PRESETS[settings.theme];

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">外观</h3>

      {/* 主题切换 */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">主题</div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => updateSettings({ theme: t.key })}
              className="px-5 py-3.5 rounded-lg text-[13px] font-medium text-center transition-all"
              style={{
                background:
                  settings.theme === t.key
                    ? theme.cardBg
                    : "transparent",
                border: `1px solid ${theme.border}`,
                cursor: "pointer",
                color: theme.text,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 圆角 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">圆角大小</span>
          <span className="tabular-nums">{settings.borderRadius}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={30}
          value={settings.borderRadius}
          onChange={(e) =>
            updateSettings({ borderRadius: Number(e.target.value) })
          }
        />
      </div>

      {/* 透明度 — 0% 完全透明, 100% 完全不透明 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">背景透明度</span>
          <span className="tabular-nums">{settings.opacity}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.opacity}
          onChange={(e) =>
            updateSettings({ opacity: Number(e.target.value) })
          }
        />
        <div className="flex justify-between text-[10px] mt-0.5 opacity-40">
          <span>0% 透明</span>
          <span>100% 不透明</span>
        </div>
      </div>

      {/* 最小态宽度 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">最小态宽度</span>
          <span className="tabular-nums">{settings.minimalWidth}px</span>
        </div>
        <input
          type="range"
          min={100}
          max={240}
          value={settings.minimalWidth}
          onChange={(e) =>
            updateSettings({ minimalWidth: Number(e.target.value) })
          }
        />
      </div>

      {/* 中等态宽度 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">中等态宽度</span>
          <span className="tabular-nums">{settings.mediumWidth}px</span>
        </div>
        <input
          type="range"
          min={160}
          max={360}
          value={settings.mediumWidth}
          onChange={(e) =>
            updateSettings({ mediumWidth: Number(e.target.value) })
          }
        />
      </div>
    </div>
  );
}
