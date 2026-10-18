import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import type { LanguageSetting, ThemeType } from "../../types";
import { THEME_PRESETS } from "../../types";
import Dropdown from "./Dropdown";

// 说明：岛样式（悬浮胶囊/贴边挂角）与水平位置已挪到「位置」页（PositionSettings），
// 本页只留与"摆在哪"无关的外观项：主题、语言、圆角、透明度、宽度。

const THEMES: { key: ThemeType; labelKey: string }[] = [
  { key: "dark", labelKey: "settings.appearance.themeDark" },
  { key: "light", labelKey: "settings.appearance.themeLight" },
];

const LANGS: { key: LanguageSetting; labelKey: string }[] = [
  { key: "auto", labelKey: "settings.appearance.langAuto" },
  { key: "zh-CN", labelKey: "settings.appearance.langZhCN" },
  { key: "en", labelKey: "settings.appearance.langEn" },
];

export default function AppearanceSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const theme = THEME_PRESETS[settings.theme];

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.appearance.title")}</h3>

      {/* 主题切换 */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">{t("settings.appearance.theme")}</div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t2) => (
            <button
              key={t2.key}
              onClick={() => updateSettings({ theme: t2.key })}
              className="px-5 py-3.5 rounded-lg text-[13px] font-medium text-center transition-all"
              style={{
                background:
                  settings.theme === t2.key
                    ? theme.cardBg
                    : "transparent",
                border: `1px solid ${theme.border}`,
                cursor: "pointer",
                color: theme.text,
              }}
            >
              {t(t2.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* 语言选择（跟随系统 / 简体中文 / English）—— 自绘下拉浮层，深色玻璃风格与日历年月菜单一致 */}
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.appearance.language")}</span>
        </div>
        <Dropdown
          value={settings.language}
          options={LANGS}
          onChange={(v) => updateSettings({ language: v })}
          t={t}
          ariaLabel="Language"
        />
      </div>

      {/* 圆角 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.appearance.borderRadius")}</span>
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
          <span className="opacity-60">{t("settings.appearance.opacity")}</span>
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
          <span>{t("settings.appearance.opacityMin")}</span>
          <span>{t("settings.appearance.opacityMax")}</span>
        </div>
      </div>

      {/* 最小态宽度 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.appearance.minimalWidth")}</span>
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
          <span className="opacity-60">{t("settings.appearance.mediumWidth")}</span>
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

