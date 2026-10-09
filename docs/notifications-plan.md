# Tauriisland 系统通知功能 — 补充与规划

> 对 `%TEMP%\tauriisland-handoff-notifications.md`（下称"交接文档"）的**实测补正 + 实施方案**。
> 本文所有「实测」结论均在本机（Windows 10/11，2026-10-09）当场验证过，可复现。
> 工作目录 `E:\Project\Tauriisland`，分支 `main`。

---

## 1. 交接文档的三处错误（必须先改，否则会返工）

### 1.1 【致命】wpndatabase.db 的表名是错的

交接文档 §4 说"主要表：`Notification`、`NotificationBinding`、`Handler`"，并要求"用 `PRAGMA table_info` 探测列名"。

**实测本机真实表清单**：

```
HandlerAssets      HandlerSettings     Metadata            Notification
NotificationData   NotificationHandler TransientTable      TimedNotification
WNSPushChannel
```

- **没有 `NotificationBinding` 表**（不存在）。
- **没有 `Handler` 表**；真实表名是 **`NotificationHandler`**。
- 正文**不在** `NotificationBinding` 里 —— 就在 `Notification.Payload`（BLOB，内容是**纯 XML 文本**）。

如果照交接文档写 SQL，会在"探测表名"那步就找不到表，并误判为"正文取不到"。

### 1.2 正文不是"常常取不到"，本机实测**全部可解析**

交接文档 §4 断言"微信/QQ 等自绘通知的文本在 NotificationBinding 的 XML payload 里，可能为空/被压缩/加密 → 解析必须容错，取不到就只显示应用名与时间"。

**实测 3 条真实 toast（原文摘录）**：

| Id | 应用 | Payload 长度 | 结果 |
|---|---|---|---|
| 4888 | `ByteDance.TraeCN` | 551 | `<binding template="ToastText02">` + `<text id="1">任务完成 · 分析项目结构和前端组件位置</text>` + `<text id="2">分析完成。这是一个 Tauri 2 桌面…</text>` |
| 4875 | `Windows.Defender.SecurityCenter` | 518 | `<binding template="ToastGeneric">` + `<text id="1">启用 Windows 防火墙</text>` + `<text id="2">Windows 防火墙已关闭。…</text>` + `<header title="Windows 安全中心">` |
| 4859 | `D:/Program Files/Steam++/Steam++.exe` | 260 | `<binding template="ToastGeneric">` + `<text/>`（空）+ `<text>检测到启动：Steam 国际服…</text>` |

结论：**文本是明文 XML，正则/轻量解析即可全量取出**。仍然保留容错（这是对的），但定位应从"大概率取不到"下调为"边界情况"。

实测到的三个真实边界，解析器必须处理：
1. **空 `<text/>` 元素**（Id 4859 第一个 text 为空）→ 不能把空串当成标题，要顺延取第一个非空 text 作标题。
2. **`<text>` 带 `id` 属性或缺省** → 两种写法都要吃（`<text id="1">` 和 `<text>`）。
3. **XML 实体**（`&amp;`）→ 必须反转义，否则界面出现 `windowsdefender://enable&amp;fw`。
4. **多条 text** → 第 1 条非空作标题、其余合并作正文，但**不要**按 `<text id="1">` 硬编码，因为 `ToastText02` 和 `ToastGeneric` 的编号习惯不同。

### 1.3 时间戳格式（交接文档未提，属关键缺失）

`Notification.ArrivalTime` 是 **Windows FILETIME（自 1601-01-01 起的 100ns 刻度）**，不是 Unix 秒/毫秒。

**实测**：`134360121382373676` → `2026-10-09 17:35:38`（与本机 WAL 最后写入时间完全吻合）；同值按 Unix-ms 解释会**超出 .NET 范围**，按 Unix-µs 会得到 `6227 年`。

Rust 实现：`(ticks / 10_000_000) - 11_644_473_600` → Unix 秒。

### 1.4 关于 `UserNotificationListener`：交接文档的谨慎是对的，但要明确结论

官方文档明确要求："you must add the **User Notification Listener** capability to your app manifest"（[Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)）。

本项目的 manifest 是 `tauri.conf.json`（**非 MSIX 打包**），**没有** `Package.appxmanifest`，无法声明该 capability → `RequestAccessAsync()` 必然返回非 `Allowed`。

**并且**：该 API 属于 **UWP/WinRT**（`Windows.UI.Notifications.Management`），本项目现有 WinRT 调用（`smtc.rs`）走的是 `windows` crate 0.58 + `Media_Control` feature。加这条链路要引入新 feature 集合 + STA 线程 + 一个注定被拒的权限申请。

→ **决定：不做这个实验**，直接走 `wpndatabase.db`。交接文档建议"先做实验确认"，是在不知道"manifest 无 capability"这一点时的合理建议；现在已知，实验只会浪费一个回合。这一条要从"建议先实验"改为"已验证不可行，直接走降级路径"。

---

## 2. 读取路径可行性（实测已完成，不再是"待验证假设"）

### 2.1 数据库可以被安全复制 —— 锁问题不存在

交接文档 §4 说"该库被系统长期占用（WAL），必须只读打开，或先复制副本到 %TEMP%；直接以写模式打开会失败"。

**实测**：在 Windows 正常运行、通知中心有 8 条数据的情况下，直接 `Copy-Item` 三个文件**全部成功**：

```
OK copy wpndatabase.db        (1,048,576 bytes)
OK copy wpndatabase.db-wal    (2,163,032 bytes)
OK copy wpndatabase.db-shm    (32,768 bytes)
```

原因：Windows 的 WPN 服务以**共享读**方式持有该文件，`CreateFile` 的读共享允许被复制。

→ **采用"复制后解析"路线，而不是"只读打开原库"**。理由见下条。

### 2.2 【关键】只读打开原库会丢数据 —— WAL 比主库还大

实测文件尺寸：

| 文件 | 大小 |
|---|---|
| `wpndatabase.db` | 1,048,576 B（1 MB） |
| `wpndatabase.db-wal` | **2,163,032 B（2.1 MB）** |
| `wpndatabase.db-shm` | 32,768 B |

**WAL 是主库的 2 倍**，意味着**绝大多数通知还在 WAL 里、尚未 checkpoint 进主库**。

推论（这是本方案最重要的一条技术决策）：
- 只开 `wpndatabase.db`（无论只读还是读写）→ **只能看到已 checkpoint 的旧数据，最新通知全部丢失**。
- 以 `SQLITE_OPEN_READONLY` 打开原库 → SQLite 在 WAL 模式下仍需要写 `-shm` 文件，只读打开**会失败**或**看不到 WAL 内容**。
- 唯一稳妥做法：**把 `.db` + `-wal` + `-shm` 三个文件一起复制到临时目录，再打开副本**（副本可写，WAL 会被正常回放/checkpoint）。

`-shm` **必须一起复制**（WAL 索引），只复制 `.db` + `-wal` 在某些情况下会因 shm 缺失而重建失败。

### 2.3 实测能取到的真实数据形态

```
Id   | PrimaryId                                  | Type  | PayloadType | Len
4888 | ByteDance.TraeCN                            | toast | Xml         | 551
4875 | Windows.Defender.SecurityCenter             | toast | Xml         | 518
4859 | D:/Program Files/Steam++/Steam++.exe        | toast | Xml         | 260
55   | ...Client.WebExperience_...!Widgets         | tile  | Xml         | 11745
53   | ...Client.WebExperience_...!Widgets         | tile  | Xml         | 11737
```

两个必须处理的形态问题：

1. **`Type` 有 `toast` 和 `tile` 两种**。`tile` 是磁贴更新（Widgets 天气等），**不是通知**，必须 `WHERE Type='toast'` 过滤，否则列表被 11KB 的磁贴 XML 灌满。
2. **`PrimaryId` 不是给人看的名字**：可能是包标识（`ByteDance.TraeCN`）、可能是**完整文件路径**（`D:/Program Files/Steam++/Steam++.exe`）、也可能是带 `!` 的复合标识（`MicrosoftWindows.Client.WebExperience_cw5n1h2txyewy!Widgets`）。

→ **应用显示名是本次最大的体验缺口**（详见 §3.4），交接文档的数据模型 `{appName, appId}` 里 `appName` 并没有现成来源。

---

## 3. 设计

### 3.1 模块与 seam（用 codebase-design 词汇）

```
Rust 侧
┌─────────────────────────────────────────────────────┐
│ notifications.rs  （深模块，小接口）                  │
│  pub fn list_notifications(limit: usize)            │
│      -> Result<Vec<NotificationItem>, String>       │
├─────────────────────────────────────────────────────┤
│ 内部 seam（私有，给 #[cfg(test)] 用）：               │
│   fn snapshot_db(src_dir) -> TempSnapshot           │  ← 复制 3 文件
│   fn parse_toast(payload: &str) -> (String, String) │  ← 纯函数，可测
│   fn filetime_to_unix(ticks: i64) -> i64            │  ← 纯函数，可测
│   fn decode_entities(s: &str) -> String             │  ← 纯函数，可测
│   fn friendly_name(primary_id: &str, xml: &str)     │  ← 纯函数，可测
└─────────────────────────────────────────────────────┘
```

界面（depth 的判断）：调用方只需要知道**一个函数、一个参数、一个错误**。复制库、WAL 回放、schema 探测、XML 解析、实体反转义、名称推导、时间换算全部藏在里面。删除这个模块，这些复杂度会立刻在调用方重现 → 它确实在 earn its keep。

**外部 seam（前端）**：`src/services/notifications.ts` 暴露一个函数：

```ts
export async function fetchNotifications(limit?: number): Promise<NotificationItem[]>
```

失败**永不抛异常**，返回 `[]`（与 `fetchMusic` / 日历的既有降级风格一致）。hook 只依赖这个 seam，不碰 `invoke`。

### 3.2 数据模型（修正交接文档的 `{id, appName, appId, title, body, createdAt, icon?}`）

```rust
#[derive(serde::Serialize)]
pub struct NotificationItem {
    pub id: i64,          // Notification.Id
    pub app_id: String,   // NotificationHandler.PrimaryId 原文（用于过滤/映射）
    pub app_name: String, // 推导出的显示名（见 §3.4）
    pub title: String,    // 第 1 个非空 <text>
    pub body: String,     // 其余 <text> 合并（\n）
    pub created_at: i64,  // Unix 秒（已从 FILETIME 换算）
    pub kind: String,     // "toast"（预留）
}
```

**去掉 `icon`**：应用图标要从包清单/`HandlerAssets` 取，未打包应用拿不到且成本高；一期不做（列为二期）。空字段比取不到的字段更诚实。

### 3.3 轮询与性能（交接文档 §4 说"≥2s"，实测后要改）

一次读取的真实成本 = 复制 **3.2 MB**（1 MB + 2.1 MB + 32 KB）+ sqlite 打开 + 解析。这不是免费的。

改法（避免无谓复制）：
1. **先用 `fs::metadata` 比对 `-wal` 的 `len` + `modified`**，与上次相同则**直接返回缓存的解析结果**，不复制。
2. 只在 WAL 变化时才复制解析。
3. 轮询间隔 **10s**（不是 2s）；展开态可见时才轮询，切走即停。
4. 前端对 `id` 做增量合并，避免每轮重建列表（否则滚动位置被打断）。

**观测项**：在 Phase B 第一步先实测一次「复制 + 解析」耗时。若 > 300ms，间隔提到 15–20s；若 WAL 在某次运行中涨到几十 MB，需要给复制加体积上限保护（超过阈值只读主库并降级）。

### 3.3.1 Phase A 实测结果（2026-10-09，已落地）

单次「三文件复制 + 打开 + 查询 + 解析」实测 **28–177ms**（WAL 2.2–2.5MB，主库 1MB，共约 3.3MB），
远低于 300ms 阈值 → **轮询间隔保持 10s 不变**，§3.3 的降级预案暂不需要。

读取到 4 条真实 toast，覆盖三类形态：

| app_name | app_id | 显示名来源 |
|---|---|---|
| `Trae` | `ByteDance.TraeCN` | 内置映射 |
| `Windows 安全中心` | `Windows.Defender.SecurityCenter` | payload `<header title>` |
| `Steam++` | `D:/Program Files/Steam++/Steam++.exe` | 路径 basename |
| `QQ` | `QQ` | payload `<header title>`（`QQ` 本身就是 AUMID） |

→ §3.4 的分级推导**四级都得到了真实数据验证**，不是纸上设计。

**Phase A 发现并修掉的一个真实解析 bug（交接文档与 plan 初稿都没预见到）**：
一条 `<text>` 元素内部**可以含真实 CRLF**。实测 Steam++ 那条的三行正文全在**第二个**`<text>` 里
（第一个是空的 `<text/>`）。若原样保留换行，就会得到一个多行"标题"、而正文为空 ——
标题/正文的拆分逻辑直接失效。修法：单个 `<text>` 内容做**换行折叠为空格**，
元素之间仍用 `\n` 连接（多行正文不丢）。已加单测 `collapses_newlines_inside_a_single_text_run`
与 `keeps_title_body_split_when_body_is_multiline` 锁住该行为。

**Phase A 的一处误判（Phase B 已更正）**：Phase A 结束时曾根据 `body_len=19` 判断"QQ 正文不完整"，
**这是错的**。Phase B 拿到 QQ 真实 payload 全文（724 字节）后确认：正文 `　：可以了` **在库里是完整的**，
19 字节正好是全角空格 + 冒号 + 3 个汉字的 UTF-8 长度。当时只看了长度字段就下结论，没有 dump 全文。
教训：判断"数据缺失"之前必须看原始内容，不要用长度之类的间接指标推断。

真实的 bug 是另一个：QQ 的第二个 `<text>` 以**全角空格 U+3000** 开头（气泡左侧缩进），
原样保留会在界面上顶出一个空档。已在 `parse_toast` 里改为**按 `str::trim` 判定"非空"**
（Rust 的 `trim` 认 U+3000），并加了两个单测锁住（`parses_real_qq_notification`、
`trims_ideographic_space_and_treats_it_as_empty`）。

**Phase B 新发现：`<image>` 元素带本地图标路径**。QQ 的 payload 里有：

```xml
<image placement="appLogoOverride" hint-crop="circle" src="D:\Users\<user>\Tencent Files\...\avatar\group\6d\s_6d..."/>
```

这**推翻了 Phase A"未打包应用取不到图标"的绝对结论** —— 图标不是"取不到"，而是
**发送方主动内联了本地绝对路径**（QQ 是自绘通知，自己把头像路径塞进 payload）。
所以图标在二期是**有可能做**的：解析 `appLogoOverride` 的 `src` → 读本地文件。
但本期明确不做，理由：① 要新增 `tauri-plugin-fs` + asset 协议配置 + `assetProtocol` scope，
权限面变大；② 路径里含用户名（隐私）；③ 老通知的路径可能已失效（头像文件被清理）；
④ 多数应用（如 Windows 安全中心把图标注册在包清单里）仍然取不到，只能拿到 QQ 这类自绘通知的。
若要立项，应作为独立的"通知图标"任务评估，不要塞进本次通知功能。

### 3.4 应用显示名推导（按优先级）

```
1. payload 里 <header title="...">  → 最准（实测 Id 4875 → "Windows 安全中心"）
2. 内置映射表（少量常见应用）        → "ByteDance.TraeCN" → "Trae"
3. PrimaryId 是文件路径             → 取 basename 去扩展名（"Steam++.exe" → "Steam++"）
4. PrimaryId 含 "!"                 → 取 "!" 前一段
5. PrimaryId 含 "."                 → 取最后一段（"Windows.Defender.SecurityCenter" → "SecurityCenter"）… 见下
6. 兜底                             → PrimaryId 原文
```

第 5 条要**谨慎**：`Windows.Defender.SecurityCenter → SecurityCenter` 反而不如原文可读。建议：
- 有内置映射的用映射（一期只放实测见过的几个：`Windows.Defender.SecurityCenter` → `Windows 安全中心`）；
- 其余保持**原文截断显示**（CSS `text-overflow: ellipsis`），不要做聪明但会出错的猜测。

**要如实告知用户的限制**：未打包应用无法通过官方 API 拿"应用显示名"，所以部分应用会显示为包标识/路径。这是平台限制，不是实现缺陷。

### 3.5 发送路径与一个必须承认的坑

装 `tauri-plugin-notification`（Rust）+ `@tauri-apps/plugin-notification`（JS），`lib.rs` 注册，capabilities 加 `notification:default`（权限表已核对：[reference.md](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/notification/permissions/autogenerated/reference.md)，含 `allow-notify`/`allow-is-permission-granted`/`allow-request-permission` 等）。

**修正交接文档两处**：

1. 交接文档说"仍要走 `isPermissionGranted()` / `requestPermission()` 流程"。源码实测：desktop 上 `request_permission()` **直接 `Ok(PermissionState::Granted)`，不弹任何提示**；`remove_active()` 在 Windows 上**是空实现**（`notify-rust` 无法撤回已显示的通知）。所以：
   - 不要指望 `requestPermission()` 有 UI 反馈（它必然立刻返回 granted，做权限引导 UI 是白做）；
   - 不要做"撤回通知"功能（Windows 平台不支持）。
2. **阅读源码发现的真实坑（交接文档没有）**：`tauri-plugin-notification` 的 `build()` 里，只有当**当前 exe 目录不以 `\target\debug` 或 `\target\release` 结尾**时才设置 `app_id`：

   ```rust
   if !(curr_dir.ends_with("\\target\\debug") || curr_dir.ends_with("\\target\\release")) {
       notification.app_id(&self.identifier);
   }
   ```

   本项目**开发时就是用 `启动.bat` → `npm run tauri dev` → exe 在 `target\debug`**，正好落在"不设置 app_id"的分支。

   影响：dev 模式下 toast 的归属应用身份不确定（可能落到默认 toast 处理程序名下）。**这不影响 toast 能否弹出**，但会影响显示的应用名/图标，也会影响"点击通知"的归属。

   → **处理**：一期接受（"能弹出"是目标）；在设置页如实说明 dev 模式下应用名可能显示异常，安装版（release/NSIS 安装后）正常。若用户要求 dev 下也正确显示应用名，需要额外做 AUMID/开始菜单快捷方式注册（列为二期待确认项，不擅自做）。

**Windows 专注助手/请勿打扰会吞通知** —— 这条交接文档说得对，测试前要提醒用户关闭。

### 3.6 设置项设计（沿用 `src/stores/settings.ts` 模式）

**已由用户确认的口径**（2026-10-09）：
- 读取范围：**默认全部应用，但可设黑名单跳过部分应用**（不是白名单）。
- 默认开关：**默认开启**。
- 发送：**先只做「测试通知」**，但**预留日程/闹钟通知的接口**以便后期接入。

新增字段（**必须同时改 `Settings` 接口 + `DEFAULT_SETTINGS` + `normalizeSettings` 四处（含 `cloneDefaults` 的数组深拷贝）**，否则违反项目"逐字段防御校验"约定、重启后设置丢失）：

```ts
// 通知
notificationsEnabled: boolean;      // 默认 true（用户确认默认开启）
notificationBlacklist: string[];    // 默认 []（空=不过滤，全读）
notificationPollMs: number;         // 默认 10000，范围 5000–60000
notificationMaxItems: number;       // 默认 20，范围 5–100
notifyOnAlarm: boolean;             // 默认 true —— 本期只存字段+接好发送 seam，无 UI 触发器
```

**黑名单语义**（明确定义，避免歧义）：
- 匹配对象是 **`PrimaryId`（app_id）原文**，规则沿用音乐白名单的**忽略大小写 + 子串匹配**（用户已熟悉这套口径）。
- 黑名单为空 = 不过滤。
- **过滤在展示层做，不在 Rust 侧做**：Rust 始终返回全部 `toast`，黑名单在 `useNotifications` 里应用。理由——读 DB 是重操作（复制 3.2MB），把过滤绑到读取上会导致"改黑名单要等下一轮轮询才生效"；展示层过滤可立即生效，且将来要加白名单也不用改 Rust。
- **单个通知行的交互**：原方案是"每行给一个『不再显示该应用』入口，直接把该行的 `app_id` 写进黑名单"。
  **该方案已废弃**（Phase D，用户反馈行内触发器不可见）—— 见下方 Phase D 的"同轮删除的功能"。
  现在黑名单的入口**只在设置页**（「从当前通知中选取」正是为替代这个行内入口而做的）。

**空态重构**：因为**默认开启**，原先设想的"未开启引导"空态不再是主路径。空态简化为「暂无通知」+ 一句检查专注助手的提示（见 Phase B）。

新增设置页：`SettingsPanel.tsx` 的 `TABS` 加一项「通知」+ `src/components/settings/NotificationSettings.tsx`，内容按以下三段组织（`WhitelistSettings.tsx` 可直接作为实现模板——同样的芯片列表 + 输入框 + 提示行 + `btnStyle`）：

1. **读取开关**：`notificationsEnabled` 开关 + 轮询间隔 + 最多条数。
2. **不读取的应用**（黑名单）：芯片列表 + 手动输入 + 「从当前通知中选取」按钮（替代白名单页的"获取播放进程"，直接列出当前 `app_id` 去重结果供勾选，因为手敲包标识不现实）。
3. **发送**：「测试通知」按钮（见 §3.5 的 dev 模式身份说明要写在这里）+ `notifyOnAlarm` 开关（标注"日程/闹钟通知接入后生效"）。

**不要**把「测试通知」按钮塞进"关于"页。

### 3.7 发送侧预留接口（用户要求"留下日程闹钟通知的接口"）

本期**不定义日程数据来源**（`dtodo` 无闹钟语义），只把发送 seam 做成一个稳定、可复用的深模块，后期接日程时不需要碰通知功能本身：

```ts
// src/services/notify.ts
export interface NotifyOptions {
  title: string;
  body?: string;
  /** 同一 key 的通知在系统里互相替换，避免闹钟刷屏 */
  tag?: string;
  /** 预留：未来点击通知要跳回岛的哪个页 */
  route?: "music" | "calendar" | "notification";
}

/** 发送一条系统通知。永不抛异常；失败返回 false（降级铁律）。 */
export async function sendNotification(opts: NotifyOptions): Promise<boolean>;
```

- 内部用 `@tauri-apps/plugin-notification`（走 §3.5 已定的路径）。
- `notifyOnAlarm` 字段与这个函数**本期都落地**，但**没有任何调用方**（除了"测试通知"按钮）→ 注释里明确写"待日程模块接入"，避免后来者以为是死代码删掉。
- **不做**周期提醒/预约通知（`Schedule`）：插件在 desktop 上忽略调度选项（源码注释已确认 "the scheduling and grouping options are ignored"），所以日程提醒必须由应用自身定时器触发，这属于日程模块的职责，不塞进本期。

---

## 4. 分阶段实施（按依赖排序，每阶段可独立验收）

### Phase A — 读取探测（**先做，因为它决定后面全部**）

1. `src-tauri/Cargo.toml` 加 `rusqlite = { version = "0.40", features = ["bundled"] }`（`bundled` 避免依赖系统 sqlite dll）。
   - 版本已核对：`rusqlite` 当前为 **0.40.1**，其 MSRV = **rust 1.88.0**；本机 `rustc 1.99.0` → 兼容，无需降级。
   - `bundled` 会编译一份 SQLite C 源码，**首次 `cargo build` 会明显变慢**（几分钟量级），属预期。
2. 写 `src-tauri/src/notifications.rs`：纯函数先落地（`parse_toast` / `filetime_to_unix` / `decode_entities` / `friendly_name`）。
3. 写 `#[cfg(test)]` 单元测试，**用实测到的 3 条真实 payload 作固定 fixture**（`ToastText02`、`ToastGeneric`+`header`、空 `<text/>`+多行）。这是本次 TDD 的确认 seam：纯函数是唯一能离线验证的层（申请读取权限、DB 访问都依赖真机）。
4. 加 `get_notifications(limit)` command，注册进 `lib.rs`。
5. `cargo test`（验证纯函数）+ `cargo check`。
6. **打印一次真实读取耗时与条数**（可加 `#[test] smoke_list_notifications`，与既有 `smoke_get_music_info` 同风格）。

**注意**：`cargo` 写 `src-tauri\target` 在受限沙箱会被拒（os error 5）→ 需要 `sandbox_permissions: "danger-full-access"`；若仍失败，用 Ctrl+Esc 开非沙箱 cmd 代跑，输出重定向回工作区。

**Phase A 出口条件**：能打印出本机真实通知条数 ≥1 且 title 非空。达不到就**停下来汇报**，不要继续做 UI。

### Phase B — 读取接入 UI ✅ 已完成（2026-10-09）

1. ✅ `src/types/notification.ts`：`NotificationItem` + `fromRaw`（Rust 是 snake_case，这里一次性映射）
   + `isBlacklisted`。
2. ✅ `src/services/notifications.ts`：`invoke("get_notifications")`，**任何异常返回 `[]`**。
3. ✅ `src/hooks/useNotifications.ts`：可注入 fetcher；按 `id` 增量合并（Map 去重 + 按时间倒序）；
   **只在展开态可见且已开启时轮询**；黑名单在此处过滤；含 `formatRelativeTime`（刚刚/N 分钟前/今天/昨天/MM-DD）。
4. ✅ `src/pages/NotificationPage.tsx`：列表 + 顶部 header（计数/全部清除）+ 相对时间；
   （Originally 还含行内「移除」/「不再显示「应用」」—— 已在 Phase D 删除，见该节）
   空态区分「通知读取已关闭」（带去设置按钮）/「读取中…」/「暂无通知」（提示检查专注助手）。
5. ✅ 设置侧：`Settings` 加 5 个字段（接口 + `DEFAULT_SETTINGS` + `normalizeSettings` + `cloneDefaults` 四处同步）；
   `NotificationSettings.tsx` 新设置页（读取开关 / 刷新间隔 / 最多显示 / 黑名单含"从当前通知中选取" / 发送段）；
   `SettingsPanel.tsx` 加「通知」页签 + 新增 `BellIcon`。

**验收状态**：`npx tsc --noEmit` 通过、`npm run build` 通过、`cargo test --lib notifications` **16 passed**。
**待用户真机确认**：展开态第 3 页能看到真实通知列表、黑名单能生效、切走该页轮询停止。

**Phase B 顺带修掉的 Rust bug**：QQ 的第二个 `<text>` 以全角空格 U+3000 开头 → `parse_toast`
改为按 `str::trim` 判空（详见 §3.3.1）。

**Phase B 的已知取舍**：
- 三页同时 mounted，故给 `NotificationPage` 传了 `visible={isExpanded}` 来 gate 轮询；
  切到音乐/日历页时**不轮询**（避免每 10s 复制 3.3MB）。
- 「移除」与「全部清除」**只隐藏本页显示，不动系统通知中心**（不误删用户的通知）。
  真要清系统通知需要 `UserNotificationListener.ClearNotifications`，本项目拿不到该权限。
- 「测试通知」按钮目前只提示"尚未接入（Phase C）"，Phase C 装插件后改为真发。

### Phase C — 发送 ✅ 已完成（2026-10-09）

**前置状态**：`NotificationSettings.tsx` 的「测试通知」按钮与 `notifyOnAlarm` 开关早已就位，
本阶段把它们接上真实发送。

1. ✅ 装插件：`tauri-plugin-notification = "2"`（实到 **2.5.1**）+ `lib.rs` 注册
   + capabilities 加 `notification:default`。
2. ✅ 新增 `src-tauri/src/lib.rs` 的 `send_notification(title, body)` 命令。
3. ✅ 新增 `src/services/notify.ts` 的 `sendNotification(opts)` 深模块
   （永不抛异常 + 预留 `tag`/`route`）。
4. ✅ 把 `handleTestNotify` 的占位提示换成真实调用，并按结果给行内提示。
5. ⏳ `notifyOnAlarm` 仍**不接任何触发器**，注释标明"待日程模块接入"。
6. ⏳ 待用户真机验证（提醒先关专注助手/请勿打扰）。

**实现选择：走 Rust 命令，而不是 `@tauri-apps/plugin-notification`**

通知的**读取**链路已经全在 Rust 侧（`notifications.rs` + 三个命令），发送也放同一侧，
好处是少装一个前端依赖、少一份前端能力授权面（capabilities 里的 `notification:default`
是插件自身注册所需；Rust 侧直接调用不走 IPC 权限）。前端只保留 `services/notify.ts`
这一个深接口。

**桌面端的三条平台限制已核实（官方 docs.rs 明文）**：

- 只用到 `title` / `body` / `icon` / `sound`；
  "the scheduling, grouping and action related options are **ignored**" →
  §3.7 里"不做定时通知"的结论得到官方文档确认。
- `request_permission()` 在 desktop 上恒返回 Granted、不弹系统提示 → 不做权限引导 UI。
- 通知撤回在 Windows 是空实现 → 不提供"撤回"能力。

**dev 模式 AUMID 提醒**：`npm run tauri dev` 时 exe 在 `target\debug`，插件不设置
AUMID，通知归属的应用身份可能显示不准（不影响能否弹出）。已写进设置页文案与代码注释。

**黑名单说明**：用户本轮要求的"黑名单机制"**在 Phase B 就已完整实现**
（设置 →「通知」→「不读取的应用」：芯片列表 + 手动输入 + 「从当前通知中选取」），
本轮无需重做，仅确认口径无误。（当时通知列表行内还有一个「不再显示「应用」」快捷入口，
但那个触发器不可见，已在 Phase D 整体删除。）

**不做**（用户口径 + 平台限制）：
- ❌ 歌曲切换通知（会碰 `useMusic.ts`，交接文档点名的禁改文件）
- ❌ 日程/闹钟的实际触发逻辑（日程数据来源尚未定义，留接口不实现）
- ❌ 撤回/取消已发出的通知（插件在 Windows 上是空实现）
- ❌ 定时/预约通知（官方文档：desktop 端 scheduling 选项被忽略）

### Phase D — 视觉打磨 ✅ 已完成（2026-10-09）

通知列表的视觉方向（沿用本项目体系：深色玻璃 + 圆角 + 发丝描边），已按下面定稿实现：

**落地的四件事**

1. **顶部 header 带发丝分隔线**：`通知 N`（计数用等宽数字）+「全部清除」。
   分隔线是**结构性**的（划出标题栏与内容区），不是装饰；hover 时「全部清除」从 muted 提到正文白。
   在此之前列表是"漂着的一片字"，没有头。
2. **每行左侧一个应用 chip**：显示名首字 + **由应用名哈希出的固定色相**
   （`appHue()`，同应用永远同色）。低饱和半透明底 + 极淡内描边。
   这是本页**唯一**的结构性装饰，作用是在密集列表里给一个可扫读的锚点 ——
   一眼能分出"这几条是同一个应用"。**不用真实图标**：未打包应用取不到，多数发送方把图标注册在包包里。
3. **类型层级定稿**：标题是焦点（白 12px **常规字重**，不靠 bold 堆重量）+ 正文次级（muted 11px）
   + 应用名 10px muted + 时间 9px muted/0.75 等宽数字。行距 9/10px，靠间距与 chip 建立节奏。
4. **空态**沿用 40px 圆形图标体系（未改动）。

**放弃的提案（重要，别再加回来）**

- ❌ 原计划的「左侧一条 2px 应用色竖线」：实现时判断它是**纯装饰**（不带任何信息），
  而这正是 frontend-design 明确警告的"无论什么主题都出现的默认装饰"。改用 chip 承担锚点职责。
- ❌ **不做**「每行一张圆角卡片 + 统一灰阴影」那种 SaaS 卡片套装 —— 岛内可用区约 530×280，
  密集列表比卡片更适合。
- ❌ 不做日期分组标题（"今天"/"昨天"）：通知本来就在今天与昨天之间稀疏分布，
  加分组头属于"给明显之事贴标签"，会占掉珍贵的垂直空间。

**同轮删除的功能（用户反馈"行内没有点图标"）**

用户原话："通知列表行内没有点图标，不过这不影响，删除这项功能的代码。"

确实是我设计失误：行内操作触发器用的是 unicode `⋯`（U+22EF）字符，**没有任何可点性提示**
（无按钮外观、无边框、opacity 仅 0.18），用户根本看不出能点。

已把**整套行内操作功能删除**，而不只是删那个字符 —— 因为触发器一删，挂在它下面的两个动作
就永远无法到达，留着只是死代码与认知负担：

- 删掉 `⋯` 触发器、行内操作行（「移除」/「不再显示「应用」」）、`actionsFor` 状态、
  `blacklistApp()`、`Row` 的 5 个 action 相关 props。
- 原来的 `removed`（逐条移除）随之失去唯一入口，**改名为 `cleared`** 并只服务于
  「全部清除」（`setCleared(new Set(allItems.map(it => it.id)))`）。
- 行内的 `onMouseLeave` 与 `position: relative` 也不再需要，一并清掉。

**能力没有丢**：黑名单入口仍然完整存在于 **设置 →「通知」→「不读取的应用」**
（芯片列表 + 手动输入 + 「从当前通知中选取」），用户上一轮已验证"黑名单测试正常"。
教训：**要用可识别的图标或带边框的按钮做触发器，不要用裸 unicode 字符**；
并且如果一个功能的入口不可见，应该删掉整个功能而不是只修外观。

**Phase B 真机验收后的修复轮（2026-10-09）**

用户真机验收：列表/黑名单/切页保持都通过，但报了 4 个问题。已修 3 个 + 1 个部分：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 消息更新延迟慢 | 轮询间隔 10s，且每轮都做完整读取（复制 3.3MB） | **两级轮询**：新增 `check_notifications` 命令只 stat 三个文件（微秒级），前端每 **1.5s** 探一次，只有报告"变了"才做完整读取；用户设定的间隔降级为兜底全刷。见下"新通知提醒"节 |
| 2 | 长消息后面看不全（如 Trae 那条 331 字） | 标题/正文硬编码 `-webkit-line-clamp: 2`，没有任何展开入口 | 行内加**点击整块 / 「展开全文」按钮**切换：展开态改用 `display:block` 不裁剪，由列表滚动承载；只有疑似被截断（长度 > 60 或正文含换行）才显示该入口 |
| 3 | 无法上下滚动，滚一下就切页 | **岛根节点** `onWheel` 对**每一个**滚轮事件都 `preventDefault()`，页内滚动容器永远拿不到滚动 | ① `handleWheel` 里先问 `canScrollableAncestorScroll()`：内容还能滚就让位，**不翻页、不 preventDefault**；② 通知列表挂原生非 passive `wheel` 监听，能滚时 `stopPropagation()`；③ 根节点改 `onWheelCapture`，且**只在真的翻页时**才 `preventDefault()` |
| 4 | 设置页上滚回到音乐页而非通知页；切页逻辑写死页数 | 硬编码魔法数字：`setExpandedPage(0)`、`setCurrentPage(2)`、`currentPage === 2`、`MEDIUM_PAGES = 3` | 新增 **`src/utils/pages.ts` 页面路由表**：页定义、`indexOfPage`、`isLastMediumPage/isLastExpandedPage`、`expandedPageOnReturn/mediumPageOnReturn`；Island 只查表不写数字。并加**跨态回落记忆**（`lastExpandedPageRef` / `lastMediumPageRef` / `maximalFromRef`）→ 从设置页上滚回到**进来之前那一页** |

> 修复 4 时我一度把"悬浮态最后一页下滚"误改成进设置面板，导致 medium→expanded 断掉，
> 读代码时发现并改回。教训：改状态机分支前先通读整条分支链，别只看要改的那一行。

### 4.1 新通知提醒（已实现，2026-10-09）

用户在真机验收后要求"接收消息弹出通知"。**形态已由用户确认**，据此实现：

| 决策 | 用户选择 |
|---|---|
| 提醒形态 | **短暂展开岛显示内容**（像灵动岛/系统 toast） |
| 停留时长 | **以 5s 为底 + 悬停不收**（"1加4"：默认 5s，鼠标移到提醒上就不自动收起） |
| 是否全部提醒 | **加开关**，可关掉提醒只留列表 |

实现链路：

1. **检测**（Rust）`check_notifications` 只 stat 三个文件（微秒级），检测到变化时
   `emit("notifications://changed")`。
2. **全局探测**（`Island`）：`state !== "expanded"` 时每 3s 探一次；展开态让位给通知页
   自己的探测，避免重复 stat。首次探测只建立基线（把已有通知全记为"已见"），
   **不会把历史通知重弹一遍**。
3. **筛选**：拉完整数据后只取"没见过的 id"且**不在黑名单**里的；一次来多条只提醒最新那条
   （避免连环弹窗）。
4. **展示**：`src/components/NotificationAlert.tsx`（应用名 + 时间 + 标题 2 行 + 正文 2 行，
   左侧 accent 竖线）。岛**不改 `state`**，只是 `getSize()` 里临时返回提醒尺寸
   （`EXPANDED_W × ALERT_H`），并渲染一层最高 z-index 的提醒层；收起后自动回原状态与页签。
   `isExpandedLayout = isExpanded || alertItem` 让留白/阴影/圆角走展开态那套规则
   （否则阴影会被窗口裁成硬边，即历史上那个"长方形黑边"）。
5. **不打扰**：已在 `expanded`/`maximal` 时不弹（用户正在看岛，列表会自己更新）。
6. **计时**：`notificationAlertMs`（默认 5000，范围 2000–15000）；`alertHoverRef` 记录指针
   是否停在提醒上，停住时顺延、移开重新计时（用 ref 不用 state，避免鼠标移动引发重渲染）。

设置项（又要四处同步）：`notificationAlert: boolean`（默认 true）、
`notificationAlertMs: number`（默认 5000，`normalizeSettings` 范围 2000–15000）。

#### 提醒的第二轮真机修复（2026-10-09）

用户验收通过，但报了两条。第一条**查证后确认不是我们的 bug**，第二条是真 bug：

**① 长文本不全 —— 不是 bug，也不是"Windows 存不全"（结论已更正）**

实测 dump 最长的一条（QQ Id 4916，809 字节）payload，正文原文是：

```
长文本1项目接受消息长文本测试 一、测试目的 本次长文本测试旨在验证系统在接收、处理和展示
大量项目消息时的稳定性、完整性与可读性，确保在信息量较大的场景下，用户仍能获得流畅、准确
的阅读体验。 二、测试环境说明 测试环境模拟了真实业务场景下的消息推送机制，覆
```

**发送方（QQ）自己就截断后带省略号发出**，`wpndatabase.db` 里存的就是这份截断文本。
完整正文从不进入通知系统（只在 QQ 窗口里），所以 Tauriisland 显示的内容与 Windows
通知中心**逐字一致**，无可修之处。全库最长 payload 仅 388 字符（Trae 那条，同样自带 `...`）。

**② 弹提醒时背景透出其它页面内容，且仍能切换状态 —— 真 bug，已修**

根因：四层内容用 `state === "xxx"` 判可见性，而提醒**刻意不改 `state`**（这是当初为了
不丢用户页签的设计），所以底下那层照样亮着；提醒层是 `inset:0` 的整块覆盖，而这些层是
半透明玻璃 → 背景（日期/天气）透出来。同时滚轮/方向键仍能改 `state`，于是"能切换状态"。

修法：
1. 新增 `layerVisible(s) = alertItem === null && state === s`，四层全部改用它 ——
   提醒期间所有常规层 `opacity:0` + `pointerEvents:none`（顺带防止隔着提醒层点到下面按钮）。
2. `alertItem` 存在时锁住状态机：`handleWheel` 直接 return、方向键/Esc 直接 return、
   `handleMouseEnter`/`handleMouseLeave` 不再安排 hover/收起定时器。
3. 收起时补状态一致性：新增 `dismissAlert()`，若指针仍停在岛上（悬停顺延过就属这种），
   重新接上"悬停进 medium"的逻辑，否则岛会停在空的 minimal 层不动。
4. `showAlert` 里做两件收尾：按当前态校准 `currentSizeRef`（避免从陈旧尺寸插值跳变）、
   复位 `alertHoverRef`（否则上一条提醒残留的悬停标记会让新提醒永不自动收起）。

#### 提醒的第三轮真机修复（2026-10-09）

用户验收通过后又报三条，全部已修：

**① 提醒有 2–3 秒延迟 —— 三个原因叠在一起**

- 探测间隔原本 **3000ms**，最坏就要等满 3s → 改为 **1200ms**
  （`check_notifications` 只 stat 文件，微秒级，高频无压力）。
- 探测 effect 的**依赖里有 `state`** → 每次状态切换都重建定时器，
  局部变量 `seen`/`primed` 反复清零，导致"时快时慢、偶尔漏弹"。
  改为把 `state` 放进 `stateRef`，`showAlert` 不再依赖 `state`，effect 依赖恢复稳定。
- 探测 effect 原本 `if (state === "expanded") return;`（让位给通知页）→
  展开态期间完全不探测，若通知页先把指纹标记为"已变化"，用户滚回收起态后
  这次变化就再也探不到、**提醒被吞掉**。已删除该早退；两个探测者调用同一个命令，
  谁先拿到 `changed` 谁处理，互不吞事件。

**② 提醒窗口过大 —— 改为测量驱动的高度**

原来写死 `ALERT_H = 132`。现在 `NotificationAlert` 自身被 `ResizeObserver` 观察，
量到内容真实高度后写进 `alertHeight`，`getSize()` 据此钳制到 `[ALERT_MIN_H=68, ALERT_MAX_H=140]`。
于是"只有标题"的通知得到矮窗口、"标题+多行正文"得到高窗口。同时把正文 `line-clamp` 从 2 提到 4、
标题从 2 提到 3，配合更紧凑的高度，视觉上不再是一个空荡的大方块。
两个细节：`dismissAlert`/`showAlert` 都会把 `alertHeight` 清成 `null`
（否则下一条提醒会先按上一条的高度弹出、再跳一下）。

**③ 设置面板滚轮无法回到展开态 —— 是我上一轮修复引入的**

上一轮为了修"滚一下就切页"，在 `handleWheel` 里加了：

```ts
if (canScrollableAncestorScroll(...)) return;
if (isInsideScrollable(target, root)) return;   // ← 元凶
```

第二行意味着"只要滚轮落在可滚动区域内就一律 return"，于是设置面板**滚到顶之后**
依然被拦下，永远无法从 maximal 回到 expanded。已删除该行：
现在只有"内容还能朝这个方向滚"才让位，滚到边界就交给状态机
（于是"设置面板滚到顶再上滚 = 回到展开态"成立）。
`src/utils/scroll.ts` 的 `isInsideScrollable` 随之不再被使用（保留函数供后续参考）。

---

## 5. 项目约定合规检查表（每阶段过一遍）

| 约定 | 本任务如何满足 |
|---|---|
| 外部 HTTP 必须用 `@tauri-apps/plugin-http` | 本功能**无外部 HTTP**（只读本地 DB）→ 无需改 capabilities 白名单 |
| UI 内边距规格（`.superpowers\...\four-states-wireframe.html`） | 展开态内容 `14px 18px`；`index.css` 有全局 `margin:0;padding:0` → 间距必须显式写 |
| 岛主体 `innerStyle` 保持 `overflow: hidden` | 不动 `Island.tsx` 的裁剪结构；只替换 `NotificationPage` 内容 |
| 子卡片 `overflow-hidden` + `minWidth: 0` | 每个通知行都要加（否则长文本把布局顶开） |
| 四态视觉统一（1px 发丝描边 + `0 2px 6px` 阴影 + 极淡高光内边） | 通知页不自己画边框/阴影，沿用岛体 |
| 不加装饰性 SVG 描边 | 明确不加（曾是"长方形黑边"根因） |
| 不动 `smtc.rs` / `useMusic.ts` / `services/*` | Phase C 已按此收窄：不做歌曲切换通知，只加新的 `services/notify.ts`（新文件，不修改既有 services） |
| 设置项三处同步（接口/默认值/校验） | §3.6 已列 5 个新字段；`normalizeSettings` 必须加，且 `notificationBlacklist` 要进 `cloneDefaults` 深拷贝（同 `musicWhitelist`） |
| 文案中文 | 全部中文；错误降级用温和提示，不刷屏 |

---

## 6. 已确认口径与仍待确认的问题

### 6.1 用户已确认（2026-10-09）

| 问题 | 决定 |
|---|---|
| 读取范围 | **默认全部应用**，但可设**黑名单**跳过部分应用（不是白名单） |
| 默认开关 | **默认开启** |
| 发送范围 | **先只做「测试通知」**，但**预留日程/闹钟通知的接口**以便后期配置 |

这三条已全部落进 §3.6 / §3.7 / Phase B / Phase C。

### 6.2 仍待确认（**都不阻塞 Phase A**，可在 Phase A 跑完后一起定）

1. **黑名单的匹配对象**：我按 `PrimaryId`（app_id）原文 + 忽略大小写 + 子串匹配设计（沿用音乐白名单口径）。
   用户看到的是**推导出的显示名**，所以匹配时 app_id 与显示名**任一命中即屏蔽**。
   （原设计里"行内『不再显示该应用』按钮写入 app_id"的那个按钮已在 Phase D 删除；
   现在写入黑名单的唯一入口是设置页，手输或从列表选取。）
   - 建议：匹配 `app_id` **或** `app_name` 任一命中即屏蔽（最符合直觉，且能覆盖"同一应用换了上报标识"的情况）。
2. **黑名单是否需要"临时屏蔽"**（例如只屏蔽 1 小时）？建议一期不做。
3. **是否需要"点击通知跳转到对应应用"**？建议一期不做（见 §6.3 原第 2 条理由）。
4. **是否需要"免打扰时段"**？建议二期。
5. **应用名显示限制能否接受**？（部分应用只能显示包标识/路径，平台限制，见 §3.4）
6. **dev 模式下 toast 应用身份可能不准，能否接受**？（见 §3.5；要做 AUMID/开始菜单快捷方式注册是额外工作量）
7. **上一轮遗留真机确认**（与本任务无关，顺手问）：
   - 日历左侧单日卡内容是否已完全收进卡片内；
   - 岛四角是否已是圆角裁剪；
   - 设置改动重启后是否保留。

### 6.3 已由方案自行定夺（如不同意请指出）

- **不做 `UserNotificationListener` 实验**：已知无 manifest capability，必然失败（§1.4）。
- **读取不做白名单**：用户要的是黑名单（§3.6）。
- **不做通知撤回**：插件在 Windows 上是空实现（§3.5）。
- **不做定时/预约通知**：插件 desktop 忽略调度选项（§3.7）。
- **去掉数据模型里的 `icon`**：未打包应用取不到（§3.2）。
- **轮询 10s 而非 2s**，且 WAL 未变时不复制（§3.3）。
- **黑名单在展示层过滤**，不在 Rust 侧（§3.6）。

---

## 7. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| WAL 未 checkpoint 导致漏读最新通知 | **高** | 三文件一起复制（§2.2），已实测可行 |
| 照交接文档用错表名 → 误判"不可行" | **高** | 已在 §1.1 更正；实现时用 `PRAGMA` 探测表存在性而非硬编码 |
| `rusqlite` + `bundled` 首次编译较慢 / 沙箱写 target 被拒 | 中 | 需 `danger-full-access`；必要时非沙箱 cmd 代跑 |
| 每轮复制 3.2MB 造成卡顿 | 中 | WAL mtime/len 比对跳过（§3.3）；Phase B 先实测耗时 |
| `tile` 类型污染列表 | 中 | `WHERE Type='toast'` |
| 应用显示名不可得 | 中 | 分级推导 + 如实告知限制（§3.4） |
| dev 模式 toast 归属身份不准 | 低 | 一期接受 + 说明（§3.5） |
| 微信/QQ 等自绘通知文本确实取不到 | 低 | 已备容错：取不到就只显示应用名 + 时间（降级铁律） |
| 改 `useMusic.ts` 违反"不要动"约定 | — | **已消除**：用户确认不做歌曲切换通知，Phase C 完全不碰 `useMusic.ts` |
| 沙箱内无法真机验证读取 | **高** | 纯函数用 fixture 单测覆盖；DB/UI 由用户真机验收 |
| 默认开启（用户口径）导致装上即读系统通知 | 低 | 尊重用户已确认口径；设置页给显眼开关 + 黑名单可即时收窄 |

---

## 8. 与交接文档的差异汇总（改了什么、为什么）

| 交接文档 | 本文 | 依据 |
|---|---|---|
| 表：`Notification` / `NotificationBinding` / `Handler` | `Notification` / `NotificationHandler` / `NotificationData` | 实测 `.tables` + `.schema` |
| 正文"常常取不到，可能在 XML 里" | 正文就在 `Notification.Payload`，实测 3/3 可解析 | 实测 payload 原文 |
| "先做实验确认 UserNotificationListener" | 已知不可行（无 manifest capability），直接走 DB | MS Learn 明确要求 manifest capability |
| "只读打开原库" | **必须三文件复制**，只读会漏 WAL（2.1MB > 主库 1MB） | 实测文件尺寸 + SQLite WAL 语义 |
| "轮询 ≥2s" | 10s，且 WAL 未变时不复制 | 单次成本 3.2MB 复制 |
| "仍要走 requestPermission 流程" | desktop 上直接返回 Granted，不做引导 UI | 插件源码 `desktop.rs` |
| （未提）| dev 模式 `target\debug` 下不设 `app_id` | 插件源码 `build()` |
| 数据模型含 `icon?` | 去掉 `icon` | 未打包应用取不到 |
| （未提）时间戳格式 | FILETIME，`ticks/1e7 - 11644473600` | 实测换算吻合 |

---

## 9. 下一步

本文只做**补充与规划**，未改任何功能代码。用户已确认三条口径（§6.1），**Phase A 可以直接开工**；§6.2 的问题都不阻塞 Phase A，可并行确认。

建议的 TDD seam（需用户确认）：**Rust 侧 `notifications.rs` 的 4 个纯函数**（`parse_toast` / `filetime_to_unix` / `decode_entities` / `friendly_name`）+ **前端 `services/notifications.ts` 的降级契约**。其余（DB 访问、UI）依赖真机，不写自动化测试。

**开工顺序**：Phase A（读探测，含真实 payload 单测）→ 拿到本机真实条数后再决定要不要调 §3.3 的轮询参数 → Phase B（UI + 黑名单）→ Phase C（测试通知 + 预留闹钟接口）→ Phase D（视觉打磨）。
