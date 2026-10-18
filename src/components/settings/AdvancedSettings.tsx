import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import type { FullscreenHideAnim } from "../../types";
import Dropdown from "./Dropdown";
import Toggle from "./Toggle";

const HIDE_ANIMS: { key: FullscreenHideAnim; labelKey: string }[] = [
  { key: "fade", labelKey: "settings.advanced.hideAnim.fade" },
  { key: "slide", labelKey: "settings.advanced.hideAnim.slide" },
  { key: "both", labelKey: "settings.advanced.hideAnim.both" },
];


export default function AdvancedSettings() {
  const { settings, updateSettings, resetSettings } = useSettings();
  const { t } = useI18n();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.advanced.title")}</h3>

      <Toggle
        label={t("settings.advanced.autoStart")}
        value={settings.autoStart}
        onChange={(v) => updateSettings({ autoStart: v })}
      />
      <Toggle
        label={t("settings.advanced.debugMode")}
        value={settings.debugMode}
        onChange={(v) => updateSettings({ debugMode: v })}
      />
      {/* 开关本身只写设置；真正同步给 Rust 检测线程的是 Island 里的 effect
          （设置页不常驻，挂在它身上会漏掉"启动时把持久化的 false 推过去"）。 */}
      <Toggle
        label={t("settings.advanced.hideOnFullscreen")}
        value={settings.hideOnFullscreen}
        onChange={(v) => updateSettings({ hideOnFullscreen: v })}
      />

      {/* 「淡入淡出」与「滑入滑出」是两条独立动画 —— 用下拉选要哪一种。
          常显而不是跟着上面的开关隐藏：否则一开一关就会在面板中间蹦出一行，
          把下面的重置按钮顶下去。 */}
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="opacity-80">{t("settings.advanced.hideAnim")}</span>
        </div>
        <Dropdown
          value={settings.fullscreenHideAnim}
          options={HIDE_ANIMS}
          onChange={(v) => updateSettings({ fullscreenHideAnim: v })}
          t={t}
          ariaLabel="Fullscreen hide animation"
        />
      </div>

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
        {t("settings.advanced.reset")}
      </button>
    </div>
  );
}
