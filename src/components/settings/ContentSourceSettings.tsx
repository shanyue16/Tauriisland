import { useState } from "react";
import { SparklesIcon } from "../Icons";
import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import { FIELD_STYLE } from "./styles";

export default function ContentSourceSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const [cityInput, setCityInput] = useState(settings.weatherCity);

  const handleSave = () => {
    const newCity = cityInput.trim();
    updateSettings({ weatherCity: newCity });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">{t("settings.content.title")}</h3>

      {/* 天气配置 */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "var(--surface-1)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t("settings.content.weather")}</span>
          <span className="text-[11px] opacity-50">uapis.cn</span>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] opacity-60">{t("settings.content.city")}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              placeholder={t("settings.content.cityPlaceholder")}
              onBlur={handleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none"
              style={FIELD_STYLE}
            />
          </div>
          <div className="text-[11px] opacity-50">
            {settings.weatherCity
              ? t("settings.content.current", { city: settings.weatherCity })
              : t("settings.content.autoLocate")}
          </div>
        </div>
      </div>

      {/* 未来扩展预告 */}
      <div
        className="rounded-lg p-4 flex flex-col items-center gap-2 opacity-60"
        style={{ background: "var(--surface-1)" }}
      >
        <SparklesIcon size={20} className="opacity-80" />
        <div className="text-[12px]">{t("settings.content.comingSoon")}</div>
        <div className="text-center opacity-50 text-[11px]">
          {t("settings.content.comingSoonHint")}
        </div>
      </div>
    </div>
  );
}
