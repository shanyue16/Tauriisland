// uapis.cn 天气 API 类型定义
// 文档: https://uapis.cn/docs/api-reference/get-misc-weather

export interface WeatherResponse {
  code?: number;
  msg?: string;
  data: WeatherData;
}

export interface WeatherData {
  // 基础定位
  province?: string;
  city?: string;
  district?: string;
  adcode?: string;

  // 当前天气
  weather: string;
  weather_icon: string;
  temperature: number;
  wind_direction: string;
  wind_power: string;
  humidity: number;
  report_time: string;

  // extended=true 时返回
  feels_like?: number;
  visibility?: number;
  pressure?: number;
  uv?: number;
  precipitation?: number;
  cloud?: number;
  aqi?: number;
  aqi_level?: number;
  aqi_category?: string;
  aqi_primary?: string;
  air_pollutants?: AirPollutants;

  // 预警
  alerts?: WeatherAlert[];

  // forecast=true 时返回
  temp_max?: number;
  temp_min?: number;
  forecast?: ForecastDay[];

  // hourly=true 时返回
  hourly_forecast?: HourlyForecast[];

  // indices=true 时返回
  life_indices?: LifeIndices;
}

export interface AirPollutants {
  pm25?: number;
  pm10?: number;
  o3?: number;
  no2?: number;
  so2?: number;
  co?: number;
}

export interface WeatherAlert {
  title: string;
  type: string;
  level: string;
  text: string;
  publish_time: string;
  publisher: string;
  guidance?: string[];
}

export interface ForecastDay {
  date: string;
  week: string;
  temp_max: number;
  temp_min: number;
  weather_day: string;
  weather_night: string;
  wind_dir_day?: string;
  wind_scale_day?: string;
  humidity?: number;
  uv_index?: number;
  sunrise?: string;
  sunset?: string;
}

export interface HourlyForecast {
  time: string;
  temperature: number;
  weather: string;
  wind_direction?: string;
  humidity?: number;
  pop?: number;
}

export interface LifeIndices {
  clothing?: { level: string; brief: string; advice: string };
  uv?: { level: string; brief: string; advice: string };
  car_wash?: { level: string; brief: string; advice: string };
  umbrella?: { level: string; brief: string; advice: string };
  air_conditioner?: { level: string; brief: string; advice: string };
  cold_risk?: { level: string; brief: string; advice: string };
  exercise?: { level: string; brief: string; advice: string };
  comfort?: { level: string; brief: string; advice: string };
  travel?: { level: string; brief: string; advice: string };
}
