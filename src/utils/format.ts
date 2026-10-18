/**
 * 显示用的格式化函数（纯函数，无副作用、无依赖）。
 *
 * 之前这里有 4 份几乎一样的实现：`Island.tsx` 与 `MusicPage.tsx` 各一个 `formatTime`，
 * `ScheduleEditor.tsx` / `SchedulePage.tsx` 各一个 `hhmm`，`useNotifications.ts` 里内联一份。
 * 差别只在"0 值返回什么"和"负值怎么办" —— 统一口径后只留这两个。
 */

/**
 * 播放进度/时长：`m:ss`，秒数向下取整（与播放器一致，1.9s 显示 0:01）。
 * 无效值（0 / 负数 / NaN）统一返回 "0:00"。
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** 24 小时制 `HH:MM`（日程时间一律用这个，不跟随系统 12/24 小时偏好） */
export function formatHm(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
