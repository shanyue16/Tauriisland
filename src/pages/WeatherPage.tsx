import { getWeatherIcon, weatherTextToIconCode } from "../components/Icons";
import { useI18n } from "../i18n";
import type { WeatherData } from "../types/weather";

interface WeatherPageProps {
  data: WeatherData | null;
}

export default function WeatherPage({ data }: WeatherPageProps) {
  const { t } = useI18n();
  const color = "var(--island-text)";

  if (!data) {
    return (
      <div
        className="w-full h-full flex items-center justify-center py-1 px-[18px] pr-[26px]"
        style={{ color }}
      >
        <div className="text-[11px] opacity-60">{t("weather.loading")}</div>
      </div>
    );
  }

  // forecast[0] = 今日, forecast[1] = 明日
  const fc = data.forecast ?? [];
  const today = fc[0];
  const tomorrow = fc[1];

  return (
    // 内边距口径（悬浮态三个页统一）：垂直 py-1 = 线框稿 mini 规格 4px，且左右对称，
    // 内容垂直居中不会偏移；左侧 18px（原 14px，用户要求别贴着窗口边缘），
    // 右侧 pr-[26px] 给竖排页码指示器（right:8）让出通道。
    // 原为 pt-1 pb-0.5（上 4px 下 2px）→ 内容整体偏上，且与加载态/音乐页不一致。
    <div
      className="w-full h-full flex items-center justify-center gap-2 py-1 px-[18px] pr-[26px]"
      style={{ color }}
    >
      {/* 今日列 */}
      <DayColumn
        label={t("weather.today")}
        iconCode={data.weather_icon}
        desc={data.weather}
        tempNow={Math.round(data.temperature)}
        high={today?.temp_max ?? data.temp_max}
        low={today?.temp_min ?? data.temp_min}
      />

      {/* 分隔竖线 */}
      <div
        style={{
          width: 1,
          height: 28,
          background: "var(--island-border)",
          flexShrink: 0,
        }}
      />

      {/* 明日列 */}
      {tomorrow ? (
        <DayColumn
          label={t("weather.tomorrow")}
          iconCode={weatherTextToIconCode(tomorrow.weather_day || "")}
          desc={tomorrow.weather_day}
          tempNow={tomorrow.temp_max}
          high={tomorrow.temp_max}
          low={tomorrow.temp_min}
        />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

interface DayColumnProps {
  label: string;
  iconCode: string;
  desc: string;
  tempNow?: number;
  high?: number;
  low?: number;
}

function DayColumn({ label, iconCode, desc, tempNow, high, low }: DayColumnProps) {
  const Icon = getWeatherIcon(iconCode);
  // 大温度显示: 实时温度优先, 没实时则用当日最高温
  const displayTemp = tempNow ?? high;

  return (
    <div className="flex-1 flex flex-col items-center justify-center min-w-0">
      <div className="text-[10px] opacity-50 leading-none mb-0.5">{label}</div>
      <div className="flex items-center gap-1">
        <Icon size={18} style={{ color: "var(--island-text)", opacity: 0.9 }} />
        {displayTemp !== undefined && (
          <span className="text-[15px] font-semibold tabular-nums leading-none">
            {displayTemp}°
          </span>
        )}
      </div>
      <div className="text-[10px] opacity-60 mt-0.5 truncate max-w-full leading-none">
        {desc}
      </div>
      {(high !== undefined || low !== undefined) && (
        <div className="text-[10px] opacity-50 mt-0.5 tabular-nums leading-none">
          {high !== undefined ? `${high}°` : "--"}
          <span style={{ opacity: 0.5 }}>/</span>
          {low !== undefined ? `${low}°` : "--"}
        </div>
      )}
    </div>
  );
}
