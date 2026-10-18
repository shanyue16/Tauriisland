# 日程与提醒：数据模型、重复规则与导入

改「日程 / 提醒 / `.ics` 导入」这部分之前先读这里。实现文件：

| 文件 | 职责 |
|---|---|
| `src/types/schedule.ts` | `CalendarEvent` / `Recurrence` / `EventException` / `Occurrence` 类型 |
| `src/utils/recurrence.ts` | 重复展开、单次例外合并、越界数据裁剪 |
| `src/stores/schedule.ts` | `schedule.json` 读写、增删改、按区间取实例 |
| `src/utils/reminder.ts` | 纯函数：算触发时刻、去重键、挑出本轮到点的 |
| `src/services/reminderScheduler.ts` | 30 秒扫描的进程内单例 |
| `src/services/ics.ts` | iCalendar 解析与导入合并 |
| `src/pages/SchedulePage.tsx` | 日程页（7 天分组列表 + 导入入口） |
| `src/components/schedule/ScheduleEditor.tsx` | 编辑弹窗（含「仅此次 / 整个系列 / 恢复默认」） |

## 1. 存储

`LazyStore("schedule.json")`，单键 `events`，写入 200ms 去抖。事件是**扁平数组**，重复规则内嵌在事件上，不预展开：

```json
{
  "id": "…",
  "title": "周会",
  "start": "2026-10-21T20:00",
  "end": "2026-10-21T21:00",
  "allDay": false,
  "location": "",
  "notes": "",
  "reminderMinutes": 10,
  "alarmEnabled": false,
  "source": "manual",
  "uid": "…",
  "recurrence": { "freq": "WEEKLY", "interval": 1, "byWeekday": 2 },
  "exceptions": [],
  "createdAt": "…",
  "updatedAt": "…"
}
```

时间一律是**本地时间字符串**（`YYYY-MM-DDTHH:mm`，无时区后缀），解析用 `parseLocal()`；不要用 `new Date(str)` 直接吞外部格式。

## 2. 重复规则

支持 `freq` = `DAILY | WEEKLY | MONTHLY | YEARLY`，搭配 `interval`、`until`（含当天）、`count`、`byWeekday`（0=周日…6=周六）、`byMonthDay`。

`seriesStarts()` 是唯一的实例生成器：上限 `MAX_OCCURRENCES = 2000` 次、无 `until` 时最多向后推 5 年 —— 这两个上限是**防止一条写坏的规则把主线程转晕**，不要随手删。

## 3. 单次例外（exceptions）

```json
"exceptions": [
  { "occurrenceDate": "2026-10-28", "action": "cancel" },
  { "occurrenceDate": "2026-11-04", "action": "override",
    "patch": { "start": "2026-11-04T22:00", "end": "2026-11-04T23:00", "title": "周会（推迟）" } }
]
```

- 键是**绝对日期** `occurrenceDate`，不是周序号 —— 事件模型里没有「学期 / 第几周」这种锚点，`.ics` 的 `EXDATE`/`RECURRENCE-ID` 也是绝对日期，两边能一对一映射。
- `action: "cancel"` 等价一条 `EXDATE`；`action: "override"` 的 `patch` 只存**与系列默认不同的字段**（全同就不写，避免出现假的「已调整」标记）。
- 编辑弹窗里的三个范围：仅此次 → 写 `override`；整个系列 → 改事件本体（含规则）；恢复默认 → 删掉该日期的例外。
- 持久化时经过 `pruneExceptions()`：丢掉越界的（不在系列里的）、重复的、超过 3660 条的孤儿数据。

## 4. 提醒

| 概念 | 语义 |
|---|---|
| `reminderMinutes` | `null` = 不提醒；`0` = 准时；正数 = 提前多少分钟（自定义上限 30 天） |
| `alarmEnabled` | 只决定**响不响铃**；岛内提醒卡与系统通知始终发（`null` 提醒除外） |
| 全天事件 | 触发时刻固定当天 09:00 |
| 去重键 | `事件 id + occurrenceDate + 触发时刻`，存在内存 `Set` 里，进程重启即清空 |

`collectDue()` 的窗口：早于触发时刻 5 秒内不提前发、晚了 30 分钟以上就记账不发（避免开机弹一堆历史提醒）、每轮最多发 2 条。扫描每 30 秒一次，扫描区间必须覆盖**最大提醒提前量**（最长 30 天），否则远期提醒永远扫不到。

响铃 30 秒自动停；点岛、按 `Alt+C`、窗口失焦都会立即停。

## 5. `.ics` 导入

- 读文件用 WebView 的 `<input type="file">` + `File.text()`，**不申请 fs 权限、不需要 Rust 侧改动**。
- 解析：折行还原、转义还原、`VALUE=DATE` 全天（`DTEND` 右开）、`DURATION`、`RRULE`（只认 `DAILY/WEEKLY/MONTHLY/YEARLY` + `INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY`）、`EXDATE`、`RECURRENCE-ID`（实例写在主事件之前也能合并）、`STATUS:CANCELLED` 整条丢弃、`VALARM` 与 `VTIMEZONE` 跳过。
- 缺 `UID` 的事件用 `djb2` 内容指纹造稳定键，保证重复导入不会变成重复条目。
- 导入前**只预览不落盘**：先算「新增 N / 更新 M」，用户确认后才 `upsertImported()`（按 `uid` 合并，保留本地 `id` 与 `createdAt`）。
- 边界：`FREQ=HOURLY` 等退化为单次并警告；带 `TZID` 的时间按本机时区理解（不联网查时区库，预览里提示）；`BYSETPOS` 与负 `BYMONTHDAY` 忽略。

## 6. 未来接课表

不需要改模型：星期 + 时间 + 周次 = `WEEKLY + byWeekday + until/count`，单双周 = `interval: 2`，停课/调课 = `cancel`/`override`。

唯一缺口是**分段周次**（第 1-8 周、第 10-18 周）。届时给 `Recurrence` 加可选 `weeks?: number[]`（`undefined` 时沿用 `until`/`count`，纯增量向后兼容），或导入时拆成两条同 `uid` 的系列。按「第 X 周」浏览需要学期锚点，放在视图/设置元数据里，**不要写进事件存储**。
