import { useScheduleStore } from "../stores/schedule";
import type { Occurrence } from "../types/schedule";
import { collectDue } from "../utils/reminder";
import { startOfDay } from "../utils/recurrence";

/**
 * 日程提醒调度（进程内单例）。
 *
 * 为什么不放在 Rust 侧：提醒只需要"到点通知 + 岛内弹一下"，两者都在前端；
 * 前端已经持有全部展开后的 occurrence（含重复规则与单次例外），
 * 挪到 Rust 要重新实现一遍 RRULE 和 exceptions，两边必然漂移。
 *
 * 扫描口径见 `src/utils/reminder.ts` 的 `collectDue`：30s 一次，过期不补发，
 * 全天事件固定在当天 09:00，`reminderMinutes === null` 不提醒。
 *
 * ⚠️ 单例是**必需**的，不是优化：
 * 去重表 `fired` 必须跨 effect 重启存活。之前把 `fired` 放在 `startScheduleReminders`
 * 内部，调用方 useEffect 一旦重跑（Island 每次重渲染都会给 `onFire` 换新身份），
 * 就会拿到空表并立刻再扫一次，于是「一个时间段的日程在提醒窗口里每秒弹一次」。
 * 现在：定时器与去重表都挂在模块级，多次调用只替换回调 + 加引用计数，
 * React StrictMode 的双挂载也不会重弹。
 */

const SCAN_MS = 30_000;

/** 基础展望窗口：24 小时（覆盖所有内置预设：0/5/10/30 分钟） */
const BASE_LOOKAHEAD_MIN = 24 * 60;
/** 自定义提醒最远 30 天，再留 1 小时余量 */
const MAX_LOOKAHEAD_MIN = 30 * 1440 + 60;

/**
 * 展望窗口必须跟着「最长的提前量」走：
 * 用户可以把提醒设成「提前 30 天」，那时 fireAt = 开始时间 - 30 天，
 * 若仍只看未来 24 小时的 occurrence，这条提醒永远不会进入视野（到点时它还没被扫到）。
 */
function lookaheadMs(events: { reminderMinutes: number | null }[]): number {
  let longest = BASE_LOOKAHEAD_MIN;
  for (const event of events) {
    if (event.reminderMinutes !== null && event.reminderMinutes > longest) {
      longest = event.reminderMinutes;
    }
  }
  return Math.min(longest + 60, MAX_LOOKAHEAD_MIN) * 60_000;
}

export interface ReminderHandlers {
  /** 到点：系统通知 + 岛内提醒都由调用方决定 */
  onFire: (occurrence: Occurrence) => void;
}

/** 已提醒过的 `事件id|occurrenceDate`，跨 effect 重启、跨重复挂载存活 */
const fired = new Set<string>();
let onFire: ((occurrence: Occurrence) => void) | null = null;
let timer: number | null = null;
let consumers = 0;

function scan(): void {
  if (!onFire) return;
  const now = new Date();
  const store = useScheduleStore.getState();
  // 提醒不依赖用户是否打开过日程页：没读盘就先读一次（load 内部幂等）
  if (!store.loaded) {
    void store.load();
    if (store.events.length === 0) return;
  }

  // 展望窗口跟着最长提前量走（自定义提醒可到 30 天），见 lookaheadMs
  const occurrences = store.occurrencesInRange(
    startOfDay(now),
    new Date(now.getTime() + lookaheadMs(store.events))
  );
  const handler = onFire;
  for (const occ of collectDue(occurrences, fired, now)) {
    handler(occ);
  }
}

/**
 * 启动扫描循环并注册回调。可重复调用：只有第一个调用真正拉起定时器，
 * 之后的调用只替换回调。返回值是**释放本次注册**的函数（引用计数归零才停表）。
 */
export function startScheduleReminders(handlers: ReminderHandlers): () => void {
  onFire = handlers.onFire;
  consumers += 1;
  if (timer === null) {
    scan();
    timer = window.setInterval(scan, SCAN_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers -= 1;
    if (consumers <= 0) {
      consumers = 0;
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    }
  };
}

/** 仅供测试/调试：清空去重表（不影响定时器） */
export function resetReminderDedupe(): void {
  fired.clear();
}
