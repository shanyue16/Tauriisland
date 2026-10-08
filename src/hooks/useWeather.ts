import { useEffect, useState, useCallback } from "react";
import { useSettings } from "../stores/settings";
import { fetchWeather } from "../services/weather";
import type { WeatherData } from "../types/weather";

// 自动刷新间隔: 15 分钟
const REFRESH_INTERVAL = 15 * 60 * 1000;

// 共享天气 hook —— minimal / medium / maximal 各态共用同一数据源,
// 避免多处独立 fetch 浪费流量和触发闪烁
export function useWeather() {
  const { settings } = useSettings();
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      try {
        const w = await fetchWeather(settings.weatherCity, force);
        setData(w);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [settings.weatherCity]
  );

  useEffect(() => {
    setLoading(true);
    load(true);

    const interval = window.setInterval(() => load(true), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, error, refresh: () => load(true) };
}
