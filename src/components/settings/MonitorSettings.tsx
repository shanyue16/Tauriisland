import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import Toggle from "./Toggle";


export default function MonitorSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.monitor.title")}</h3>

      <Toggle
        label={t("settings.monitor.multi")}
        value={settings.multiMonitor}
        onChange={(v) => updateSettings({ multiMonitor: v })}
      />
      <Toggle
        label={t("settings.monitor.dpi")}
        value={settings.dpiAware}
        onChange={(v) => updateSettings({ dpiAware: v })}
      />
    </div>
  );
}
