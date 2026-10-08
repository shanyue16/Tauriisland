import { fetch } from "@tauri-apps/plugin-http";
import type { WeatherData } from "../types/weather";

const BASE_URL = "https://uapis.cn/api/v1/misc/weather";
// 缓存有效期 (ms): 15 分钟
const CACHE_TTL = 15 * 60 * 1000;

interface CacheEntry {
  data: WeatherData;
  timestamp: number;
  city: string;
}

let cache: CacheEntry | null = null;

/**
 * 获取天气数据
 * @param city 城市名，空字符串时按 IP 定位
 * @param force 强制刷新，跳过缓存
 */
export async function fetchWeather(
  city: string = "",
  force: boolean = false
): Promise<WeatherData> {
  // 检查缓存
  if (!force && cache && Date.now() - cache.timestamp < CACHE_TTL && cache.city === city) {
    return cache.data;
  }

  const params = new URLSearchParams();
  if (city.trim()) {
    params.set("city", city.trim());
  }
  // 请求扩展数据: 体感、AQI、预警、多天预报、生活指数
  params.set("extended", "true");
  params.set("forecast", "true");
  params.set("indices", "true");

  const url = `${BASE_URL}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      connectTimeout: 8000,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    // uapis 响应格式: { code: 200, msg: "success", data: {...} }
    // 但也可能直接返回 data（取决于 endpoint），这里做兼容
    if (json.code !== undefined && json.code !== 200) {
      throw new Error(json.msg || `API error ${json.code}`);
    }

    const data: WeatherData = json.data ?? json;

    // 更新缓存
    cache = {
      data,
      timestamp: Date.now(),
      city,
    };

    return data;
  } catch (err) {
    // 有缓存但过期了 — 网络失败时返回旧缓存
    if (cache) {
      console.warn("[weather] API 请求失败，使用旧缓存:", err);
      return cache.data;
    }
    throw err;
  }
}

/** 清除缓存 */
export function clearWeatherCache() {
  cache = null;
}
