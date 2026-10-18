import { useI18n } from "../../i18n";

export default function About() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.about.title")}</h3>

      <div className="flex flex-col items-center py-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
          style={{ background: "var(--surface-2)" }}
        >
          <span className="text-2xl">🏝️</span>
        </div>
        <div className="text-[14px] font-semibold">Tauriisland</div>
        <div className="text-[11px] opacity-50 mt-1">{t("settings.about.subtitle")}</div>
        <div className="text-[10px] opacity-40 mt-1">{t("settings.about.version", { version: "0.1.0" })}</div>
      </div>

      <div
        className="rounded-lg p-3 text-[11px] opacity-60 leading-relaxed"
        style={{ background: "var(--surface-1)" }}
      >
        {t("settings.about.description")}
      </div>

      <div className="text-[10px] opacity-40 text-center">
        {t("settings.about.stack")}
      </div>
    </div>
  );
}
