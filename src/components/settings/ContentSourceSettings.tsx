import { useState } from "react";
import { SparklesIcon } from "../Icons";
import { useSettings } from "../../stores/settings";

export default function ContentSourceSettings() {
  const { settings, updateSettings } = useSettings();
  const [cityInput, setCityInput] = useState(settings.weatherCity);

  const handleSave = () => {
    const newCity = cityInput.trim();
    updateSettings({ weatherCity: newCity });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">内容源</h3>

      {/* 天气配置 */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "rgba(255,255,255,0.05)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">天气</span>
          <span className="text-[11px] opacity-50">uapis.cn</span>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] opacity-60">城市</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              placeholder="留空 = 按 IP 自动定位"
              onBlur={handleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "var(--island-text)",
              }}
            />
          </div>
          <div className="text-[11px] opacity-50">
            当前: {settings.weatherCity ? settings.weatherCity : "自动定位"}
          </div>
        </div>
      </div>

      {/* 未来扩展预告 */}
      <div
        className="rounded-lg p-4 flex flex-col items-center gap-2 opacity-60"
        style={{ background: "rgba(255,255,255,0.03)" }}
      >
        <SparklesIcon size={20} className="opacity-80" />
        <div className="text-[12px]">即将推出</div>
        <div className="text-center opacity-50 text-[11px]">
          音乐播放、系统通知、CPU-内存-电量-网络状态
        </div>
      </div>
    </div>
  );
}
