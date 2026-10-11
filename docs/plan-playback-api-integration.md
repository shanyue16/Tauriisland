# 计划：本地「正在播放」API 接入（Folia / Now Playing / Nexus）

> 生成于 2026-10-11。前置交接：`Temp/handoff-folia-settings-release.md`（已过时，仅作历史）。
> 本文取代该交接文档中 §2 的接入设计部分。

---

## 0. 范围锁定（用户拍板）

**只做 API 接入。** 三条边界：

| | |
|---|---|
| ✅ **做** | 作为**客户端**调用本机已有的 API（HTTP 为主），做数据映射、匹配、降级、设置、测试、发布 |
| ❌ **不做** | 自研采集内核：进程内存读取 / CDP 远程调试 / AOB Hook 注入 / 音频回环捕获 |
| ❌ **不做** | 拉起、守护、安装第三方程序。只做「探测 + 显示状态 + 给下载地址」 |

依据（已定论的架构决策）：Tauriisland **已经有采集内核** `src-tauri/src/smtc.rs`（WinRT SMTC）。缺的不是内核，是 SMTC 拿不到的东西（逐字/翻译/音译/波形/无 SMTC 会话的平台）。这些第三方工具已经填好了，**Folia（4.2k★）自己也是订阅它们而不是自研**。

---

## 1. 目标架构

```
                 ┌─────────────────────────────────────────────┐
   [播放器] ─────┤ 第三方搭桥（用户自装，非硬依赖）              │
                 │  · Folia            127.0.0.1:32109 / 32107 │
                 │  · Now Playing      127.0.0.1:9863          │
                 │  · Nexus PlayerCap  127.0.0.1:8765          │
                 └───────────────────┬─────────────────────────┘
                                     │ HTTP（plugin-http + capability scope）
                                     ▼
   [SMTC 内核 smtc.rs] ────────►  Tauriisland
        （控制通道）              · playbackSources/*  外部源适配器
                                 · 数据优先级：外部源 > SMTC 兜底
                                 · 控制优先级：SMTC 唯一
```

三条不可违反的原则：

1. **可选依赖**：没装 / 没启动 / 端口不通 → **静默降级**到 SMTC + 现有歌词级联，界面无差别。
2. **数据 vs 控制分离**：**数据**（歌词/逐字/翻译/进度）可用外部源；**控制**（上一首/播放/暂停/seek）**始终走 SMTC**。唯一例外是 Folia Stage API 的 `/stage/player/control`（Phase 4，可选）。
3. **不代管进程**：不 spawn、不守护、不修改第三方程序。设置页只显示「检测到 / 未检测到」。

---

## 2. 外部源清单

| 源 | 端点 | 传输 | 鉴权 | 提供 | 优先级 | 现状 |
|---|---|---|---|---|---|---|
| **Folia 歌词接口** | `127.0.0.1:32109/v1/lyric` | HTTP | 无 | 歌词 + 原生/合成逐字 + 翻译 + 音译 + 背景人声 | **P1（第一级）** | ✅ 在跑 |
| **Now Playing** | `127.0.0.1:9863` | HTTP API（`/api/ws/lyric` 是 WS 版） | 无 | 歌名/歌手/专辑/封面/时长/进度/播放状态/歌词；**20+ 平台** | P2 | ❌ 未监听 |
| **Nexus PlayerCap** | `127.0.0.1:8765` | **HTTP（查询）/ SSE / WS** | 无 | 逐字(`text_detailed`)+翻译+音译+封面(URL+base64)+进度+**真实音频波形** | P3 | ❌ 未监听 |
| **Folia Stage API** | `127.0.0.1:32107` | HTTP + WS | **Bearer token** | 播放器状态/时间/队列 + **控制**（next/prev/pause/resume/seek） | P4（可选） | ❌ 未监听 |
| LX Music open-api | 端口待定 | 待定 | 待定 | 待定 | 待定 | 需先取证 |

**优先级理由**：Now Playing 覆盖面最广（20+ 平台）且**不需要管理员权限**；Nexus 数据最厚但需用户以管理员跑一个 Go 程序，受众偏主播圈。

---

## 3. 分阶段

### Phase 0 — 基础件（半天）

1. **capability**（`src-tauri/capabilities/default.json` 的 `http:allow-fetch`）
   **必须显式写端口**（A0 已源码级验证：不写端口的 `http://127.0.0.1/*` 会**静默失配**非默认端口）：
   ```json
   { "url": "http://127.0.0.1:32109/*" },
   { "url": "http://127.0.0.1:32107/*" },
   { "url": "http://127.0.0.1:9863/*"  },
   { "url": "http://127.0.0.1:8765/*"  },
   { "url": "http://127.0.0.1:*/*"     },
   { "url": "http://localhost:*/*"     }
   ```
   联动提交 `src-tauri/gen/schemas/*.json`；**改后必须重编译**（ACL 编译期打进二进制）。
   首次实测确认 `http://127.0.0.1:*/*` 通配是否生效（插件自身测试只覆盖显式端口）。

2. **类型扩展**（`src/types/lyrics.ts`）—— 全部可选，5 个现有源一行不改：
   ```ts
   export interface LyricWord { text: string; start_ms: number; end_ms: number }
   export interface LyricLine {
     time_ms: number;
     text: string;
     end_ms?: number;
     words?: LyricWord[];
     translation?: string;
     romanization?: string;
   }
   ```

3. **外部源骨架** `src/services/playbackSources/`：`types.ts` + 一个统一接口
   ```ts
   interface PlaybackSnapshot {
     track: { title: string|null; artist: string|null; durationMs?: number;
              positionMs?: number; playing?: boolean; coverUrl?: string|null };
     lyrics?: { lines: LyricLine[]; wordByWord: boolean; offsetMs?: number };
   }
   interface PlaybackSource {
     id: 'folia' | 'nowPlaying' | 'nexus' | 'stage';
     probe(signal): Promise<boolean>;      // 廉价连通性探测
     fetch(signal): Promise<PlaybackSnapshot | null>;  // 永不抛异常
   }
   ```

### Phase 1 — Folia 32109（第一级，唯一现在就活的源）

- `src/services/playbackSources/folia.ts`
  - `tauriFetch` + `AbortSignal.timeout()`（**不用** lyrics.ts 的 `withTimeout`，后者不真正中止请求）
  - 解析：`LyricData | null`；**`null` 是正常态**（没在播/加载中/没歌词），不是故障
- **匹配（防错显，最高优先级）**：
  1. 优先用顶层可选 **`title` / `artist`** 字段
  2. 缺失时回退解析 `lines[0]`（格式 `<曲名> - <歌手1>/<歌手2>`；**按第一个 ` - ` 拆，歌手再按 `/` 拆**）
  3. 复用 `lyricsProviders/matcher.ts` 打分，**双条件**：`titleScore ≥ 0.9` **且** 总分 ≥ 70；不匹配 → 丢弃
- **过滤**：`lines[0]` **仅在判定为元数据行时**丢弃（不能按索引无条件丢）；滤掉零长度行（`start >= end`，如酷狗推广行）、`......` 占位行、空文本行
- **时间轴**：行/字时间是**秒**；官方公式 `歌词时间 = 播放时间(秒) − offset/1000`，再叠加我们的 `lyricOffsetMs`
- **逐字**：`wordByWord=true` → 做卡拉OK逐字；`false` → 合成时间轴，按 `wordByWordEnabled` 决定是否逐字，否则行级
- 接入点：`fetchLyricsMulti` 里放最前（enabled 且 endpoint 非空时）
- 逐字渲染面：**展开态 `LyricsBlock`（5 行，只对当前行做逐字 span）**；失焦态 `MinimalContent` 保持整行高亮（用户可改）
- **provider 变化要重取**：加 `lyricSourceKeyRef`（endpoint|enabled|wordByWord 指纹），指纹变了且当前无本地歌词 → 重取（否则中途启动 Folia 不会补上）

### Phase 2 — Now Playing 9863

- 先取证：**HTTP API 端点清单**（已知 `ws://localhost:9863/api/ws/lyric` 是 WS 版；`/api/...` 下大概率有 HTTP 路由）
- **优先 HTTP 轮询**，避免引入 WebSocket 传输
- 若只有 WS 可用：走 **WebView 原生 `WebSocket`**（`csp: null`，无 CSP 限制；WS 不受 CORS 约束），不进 Rust

### Phase 3 — Nexus PlayerCap 8765

- README 明确有 **HTTP（查询）** 接口 → 走 plugin-http，复用 Phase 0 的 capability
- 映射 `text_detailed`（逐字）→ `LyricWord`、`sub_text`（翻译）、`roma_text`（音译）
- 音频波形（`/audio-ws` 二进制流）**本期不做**，留作二期（岛上的 `AudioWaveLine` 可对接）

### Phase 4 — Folia Stage API 32107（可选，含控制）

- 需要用户开 Stage Mode 并复制 Bearer token → 设置里加 token 输入框
- 能驱动岛上**已有的**上一首/播放/下一首（`POST /stage/player/control`）
- 也可用 `GET /stage/player/time` 校准进度
- **本期可不做**，等 P1–P3 稳定后再评估

---

## 4. 设置项

**落点：并入现有「歌曲」页**（`WhitelistSettings.tsx`），**不新增第 10 个标签页** —— 内容区可用高度 250px，10 项 ×25px = 250 零余量，有被裁风险。

| 字段 | 默认 | 范围 | Phase |
|---|---|---|---|
| `localLyricEnabled` | `true` | bool | 1 |
| `localLyricEndpoint` | `http://127.0.0.1:32109/v1/lyric` | 文本（非法 URL 回退默认） | 1 |
| `localLyricTimeoutMs` | `1200` | 300–5000 | 1 |
| `wordByWordEnabled` | `true` | bool | 1 |
| `lyricOffsetMs` | `0` | −2000…2000（正=歌词提前） | 2 |
| `lyricSources` | 全开 | 各源开关（**不做拖拽排序**） | 2 |
| `lyricFontScale` | `1.0` | 0.85–1.3 | 2 |
| `stageApiToken` | `""` | 文本 | 4 |

**同步点（本次是五处，不是四处）**：
`Settings` 接口 + `DEFAULT_SETTINGS`（`types/index.ts`）、`normalizeSettings`（`stores/settings.ts`）、**`cloneDefaults`（新增数组 `lyricSources` 必须补深拷贝** —— 现在只深拷贝 `musicWhitelist`/`notificationBlacklist`）、设置面板组件。

UI 硬约束：只用主题变量（`--island-text/-muted/-border/-input-bg/--surface-*`），**禁写 `rgba(255,255,255,…)`/`#fff`**；**禁写 Markdown `**`**（JSX 会原样显示星号）。

---

## 5. 轮询与性能

**不做「每源定时无脑轮询」**，用事件驱动 + 兜底：

```
SMTC 每 500ms 汇报当前曲目（已有）
   ├─ 曲目变了 / 本地还没有这首歌的歌词  → 立刻问一次外部源
   ├─ 兜底：每 5s 问一次（覆盖「歌词晚到」「用户改了 offset」）
   └─ 其它时间不问
```

- 官方（Folia）也建议 500–1000ms 低频轮询并比较内容；歌词对象只在切歌/加载完成/来源变化/调偏移时更新，**不随进度变化**
- **全部请求必须有真超时**（`AbortSignal.timeout`），本机服务慢就等于没有
- 缓存：`lyricsCache` 键要带**源标识**，避免换源后拿到旧源的结果
- 顺手修：`lyricsCache` 目前**无上限**，加 200 条 FIFO

---

## 6. 验收 & 暴力测试

**正向**（需要用户配合启动对应程序）
| 场景 | 判定 |
|---|---|
| Folia 放**同一首** | 展开态逐字高亮；元数据行/推广行/`......` 不出现在界面 |
| Folia 放**别的**歌 | 走既有级联，**不错显** |
| Folia 未运行 / `null` / 半截 JSON / 挂起 10s | **<1.5s 回落**，界面与现在无差别，无未捕获 rejection |
| 切歌 20 次 | 无请求堆积、缓存键不无限增长 |

**畸形输入注入**（stub server，沙箱内可做）
`{"lines":[]}`、`wordByWord:false`、`200 + null`、半截 JSON、返回 HTML、连接挂起、404/405

**UI 极限**：超长歌名/纯 emoji/0 行/1000 行歌词/进度 0%·100%·duration=0 → 用 `.superpowers/brainstorm/session/content/` 静态稿 + ego 截图自检

**性能**：连续 10 分钟看 CPU/WS；确认未启用外部源时**零额外请求**

---

## 7. 风险登记

| 风险 | 级别 | 缓解 |
|---|---|---|
| 曲目匹配误判 → 错显别人歌词 | **高** | 双条件阈值；宁可无 |
| capability 通配端口不生效 | 中 | Phase 0 先验；退化为显式端口列表 |
| Now Playing 只有 WS 没有 HTTP | 中 | 退路：WebView 原生 WS（不进 Rust） |
| 外部源与 SMTC 数据打架 | 中 | 明确分工：数据外部源、控制 SMTC |
| 第 10 个设置页被裁 | 中 | 已决定并入「歌曲」页，规避 |
| `lyricsCache` 无上限 | 低 | 加 200 条 FIFO |
| 逐字 15Hz 重渲染开销 | 低 | 仅当前行做逐字 span |

---

## 8. 提交切分

1. `feat(sources): 外部「正在播放」源骨架 + capability（显式端口）`
2. `feat(lyrics): 接入 Folia 本地歌词接口（32109）+ 逐字时间轴`
3. `feat(settings): 歌曲页新增本地歌词接入设置`
4. `feat(sources): Now Playing 9863 适配器`
5. `feat(sources): Nexus PlayerCap 8765 适配器`
6. `fix(lyrics): lyricsCache 加上限`
7. `chore(release): 版本号 → x.y.z`

UI 观感类改动需用户真机确认后再 push（项目既有规则）。

---

## 9. 环境与提权矩阵

| 操作 | 沙箱内 | 需要 |
|---|---|---|
| `npx tsc --noEmit` | ✅ | 无需提权 |
| `npm run build` / `npm run tauri build` | ❌ `spawn EPERM` | `danger-full-access` |
| `cargo build/check/test` | ❌ | `danger-full-access`（装好后可 `--offline`） |
| `git push` | ❌ `SEC_E_NO_CREDENTIALS` | `danger-full-access` + Watt Toolkit |
| 访问本机 HTTP（127.0.0.1） | ✅ 可探测 | — |

- 端口 1420 占用只能信 `netstat -ano | findstr ":1420 " | findstr "LISTENING"`（`Get-NetTCPConnection` 漏 IPv6）
- 改完前端必须**重启/重编译**才生效（用户常跑的是旧构建产物）

---

## 10. 待拍板

1. **D4 发布**：版本号定多少（三处现均为 `0.1.0`）？是否建 GitHub Release（`gh` 未装，需网页手动上传或先装）？
2. **Phase 4（Stage API + 控制）**：现在做还是等 P1–P3 稳定后再说？
3. **LX Music**：要接的话需要先取证它的 open-api 契约（端口/端点/响应）；它是独立第三方源，与 Folia 无关。

---

## 11. P4 实测结果与实现（2026-10-11，真机取证）

### 11.1 与计划书原本的假设不同：Stage 给的东西比预期多

原计划把 32107 写成"可选、最后做、含控制"。实测（用户提供 token 后）发现它是
**目前唯一能给出播放进度的本地源**，字段比 SMTC 还全：

```jsonc
// GET http://127.0.0.1:32107/stage/player/status   （需 Authorization: Bearer <token>）
{
  "domain": "player-playback", "direction": "inside-out",
  "current": { "id": "...", "source": "kugou", "title": "캐치 캐치", "artist": "YENA",
               "album": "LOVE CATCHER", "durationMs": 180000,
               "coverUrl": "blob:file:///..." },          // ← blob，我们取不到
  "playerState": "PAUSED",
  "positionMs": 91747, "durationMs": 180000,
  "sampledAtMs": 1791712654553,                            // ← Unix 毫秒
  "controlCapabilities": { "play":true,"pause":true,"resume":true,"seek":true,"previous":true,"next":true },
  "queueCapabilities": { ... }, "queue": { "currentIndex": 26, "length": 30, ... }
}
```

三条关键实测结论：

1. **`sampledAtMs` 是 Unix 毫秒**（与 `Date.now()` 同域，同一台机器同一个时钟）
   → 可以直接当作 `useMusic` 现有那套「按基准时间戳外推」的锚点，
   `pos = progressBase + (Date.now() - progressBaseTs) / 1000` 原样成立，**不用改 tick 的算术**。
2. **`current.coverUrl` 可能是 `blob:file:///…`** —— Folia 渲染进程内部的对象 URL，
   我们的 webview **取不到**。队列条目才是真的 `https://imge.kugou.com/…`。
   → 封面**不要**指望这个字段，继续走 酷狗 union_cover / iTunes 那两条路。
3. **`/stage/health` 免鉴权，其余一律 401**。`health` 里的 `activeEntryKind: null`
   指的是"有没有推上去的 stage 条目"，**与播放器无关**，不要误读成"没在播"。

**身份核对**：32109 的歌词（`캐치 캐치 (Catch Catch) - YENA (崔叡娜)`，末行 178.75s）
与 32107 的 `current`（`캐치 캐치 / YENA`，`durationMs` 180000）**指向同一次播放** ——
两个接口说的是同一件事，可以互相印证。

### 11.2 本期实现（commit 见下）

- `src/services/playbackSources/stage.ts`：`fetchStageSnapshot(want)` → `{snap, matched} | null`，
  **永不抛异常**；401 / 连不上 / 超时 / 无在放项 各自区分并写入诊断。
- 采纳门槛**刻意比 `folia.ts` 宽松**：曲名或歌手任一"归一化后互相包含" + 时长相容（±15s）。
  理由写在文件头 —— 这里猜错只是进度条偏一点（下一拍自我纠正），
  而误杀的代价是**这个功能永远不生效**（本项目为此已经栽过四次）。
- `useMusic.ts` 的接线（4 处，全部只在 `matched === true` 时生效）：
  1. `hasTimeline` 把 Stage 也算作"有真时间线" → 不再无脑按"有会话即在播"
  2. `playing` 接受 Stage 的 `playerState === "PLAYING"`
  3. **时长优先级链**插入 Stage（紧跟 SMTC，同为"播放器自报"信任级别）
  4. **位置锚点**改用 Stage 的 `positionMs` / `sampledAtMs`，并把 `lastLutRef` 置空
     （那个分支用 SMTC 的 LUT，而酷狗侧根本没有）
- 设置新增 4 项：`stageApiEnabled`（默认关）、`stageApiToken`、`stageApiEndpoint`、
  `stageApiTimeoutMs`。**token 只存在本机设置里，绝不进仓库。**
- 设置页「歌曲」段新增第 ⑤ 块：开关 + token（password 输入）+ 地址 + 最近一次结论
  （含 Stage 在放哪首、进度、播放状态、有没有采纳）。

### 11.3 明确**没有**做的

- **暂停时的"冻结"没有额外处理**：身份核对通过且 Stage 报 PAUSED 时，
  如果 SMTC 仍报在播，进度仍会外推。要修就得让 Stage 的 `playerState` 覆盖 SMTC 的
  `playing`，风险是"同一首歌在 Folia 里暂停、在另一个播放器里在放"这种双源场景。
  **注意：`playing` 那一处后来确实接上了 Stage（见 §12），但"覆盖"仍然没做。**
- **封面没有从 Stage 取**（blob URL 取不到，见 11.1-2）。

---

## 12. 第二个控制通道（Stage API，2026-10-11，用户拍板开启）

计划 §0 原定的分工是「**控制始终走 SMTC**」。用户拍板例外：
Stage API 的 `controlCapabilities` 全为 true，且它是**唯一能在「系统媒体接口不上报时间线」
的播放器（酷狗）上真正控制到播放**的通道 —— 所以开第二个通道。

### 12.1 官方 `POST /stage/player/control` 契约（取自 API_SCHEMA.md，**不要猜**）

```ts
interface StagePlayerControlRequest {
  action: 'next' | 'prev' | 'pause' | 'resume' | 'seek';
  positionMs?: number;          // action==='seek' 时必填；**必须非负整数**，服务端向下取整
}
// 200 → { accepted: true, action, playbackContext, ... }
```

⚠️ **动作枚举里没有 `play`** —— 起播要发 `resume`。
（`controlCapabilities` 里的 `play: true` 是"能力"字段，不是可用的动作名。）

错误码（决定回退策略的关键）：
`400 INVALID_STAGE_PLAYER_CONTROL_JSON` / `400 ..._ACTION` / `400 ..._SEEK_POSITION` /
`409 STAGE_PLAYER_CONTROL_UNSUPPORTED` /
`503 ..._UNAVAILABLE` / `504 ..._REQUEST_TIMEOUT` / `502 ..._REQUEST_REJECTED`

### 12.2 路由与回退（代码在 `src/services/playbackControl.ts`）

- **什么时候走 Stage**：已启用 + token 有效 + **最近 2.5s 内核对通过**
  （即确认过「Stage 报的曲目就是我们正在放的这首」）。其余情况一律走原来的 SMTC ——
  没装 / 没开 / 放的不是同一首时，行为与从前**完全一致**。
- **`toggle` 的映射**：UI 只有「播放/暂停」一个键，路由到 Stage 时按它报的
  `playerState` 决定发 `pause` 还是 `resume`（因为它没有 `play`）。
- **失败要不要回退 —— 只有「明确被拒」才回退**：
  - 4xx（动作不支持 / 参数非法）→ 指令**确定没生效** → 安全回退 SMTC
  - 5xx / 超时 / 网络错 → **结果未知** → **不回退**。否则会冒"双动作"的险
    （pause 其实成功了但响应丢了，再发一次 SMTC `toggle` 反而把它恢复播放）
- **`seek` 只有 Stage 支持**（SMTC 侧没有 seek 命令）。2026-10-11 用户拍板加上入口，
  展开态进度条现在可点可拖（见 §13）。
- 调用方（`Island.tsx` 的三个按钮）只报**语义动作**（`toggle`/`prev`/`next`），
  不关心走哪条路；这与已有的 `fetchLyricsMulti` 只关心"拿到歌词"是同一个思路。

### 12.3 可观测性

「点的是哪条路」记进 `status.ts` 的 `ControlStatus`，设置页 Stage 那一段会显示
`上一次控制：toggle → Stage API（成功）` 之类。**这是"按了没反应"时唯一能分清原因的地方**
（Stage 拒了？SMTC 没生效？两条都没走？），与之前给歌词链路配诊断旁路是同一个理由。

---

## 13. 拖动跳转（seek UI，2026-10-11 用户拍板）

展开态音乐页的进度条现在**可点可拖**。三处实现细节都是踩过才知道的：

**① 命中区必须撑高，不能拿 5px 的条当目标。**
条本体只有 5px，直接挂在它上面基本点不准。做法：外层容器 `padding: 6px 0` 把可点/可拖
范围撑到 **17px**，再用等量 `margin: -6px 0` 抵消 —— 视觉位置与原实现**逐像素一致**。
`getBoundingClientRect()` 因此量到的是带内边距的盒子，但水平方向没有内边距，
所以 `clientX → 比例` 的映射不受影响。

**② 拖动过程只做本地预览，松手才发请求。**
拖动中每一像素都发 `POST /stage/player/control` 显然不行。所以 `pointerdown/move` 只更新
本地 `scrubSec`，`pointerup` 才 `controlPlayback("seek", sec)`。
拖动中把条的 `transition` 置为 `none`（否则游标追不上指针）。

**③ 跳完必须由本地接管显示，直到真实位置跟上。**
主轮询 500ms 一次。如果 `pointerup` 之后立刻把显示权交还给 `data.position`，
条会**先弹回原处、再跳到目标**，看起来就像没生效。
所以维护一个 `scrubSec` 覆盖值 + **绝对截止时间**（2.5s）：
真实位置与它相差 < 2.5s 就交还，或者到点强制交还（兜底：seek 失败时不会永久显示假位置）。
定时器按绝对时间算，所以每一拍重新布置也不会把它越推越晚。

**④ hook 必须摆在提前 return 之前（这条最隐蔽）。**
`MusicDetailView` 里有个 `if (!data?.active) return (...)`。我第一版把 `useRef/useState/useEffect`
放在了它**后面** —— 曲目一旦变成"无活跃音乐"，前后两次渲染的 hook 数量就不一致，
运行时直接抛 `Rendered fewer hooks than expected`。**tsc 完全不报这个错。**
所以那个组件的规矩是：**hook 全在提前 return 之前，计算逻辑在之后**（代码里已标注释）。

**没做的**：悬浮态（medium `MusicPage`）那条 3px 进度条**不可拖** —— 它是 hover 态的过场，
在里面做拖拽与"鼠标一移开就收起"的交互相冲。要做的话得先改 hover 收起策略。

**可发现性**：可跳转时条上有 `data-tip="点击或拖动可跳转"`（沿用项目禁原生 `title` 的约定），
不可跳转时既不给提示也不改光标 —— 不摆出一个按不动的 affordance。

**逻辑已抽成 `src/hooks/useScrub.ts`**，展开态与悬浮态共用同一份 ——
这段逻辑四处都是坑（本地预览、绝对截止时间、拖动期间忽略真实位置、指针捕获），
抄两份迟早只修一处。

### 13.1 悬浮态（medium）也做了 seek，并补上播放控件（2026-10-11 用户要求）

**几何（2026-10-11 第二轮按用户要求定稿）：宽 320、高 74。**
- **宽**：有音乐时悬浮态**与失焦态音乐窗口同宽**（都用 `MINIMAL_W_WITH_MUSIC = 320`）——
  两态切换不会横向抖一下。没有音乐时才用用户设的 `mediumWidth`。
  第一版曾把 `DEFAULT_SETTINGS.mediumWidth` 当唯一来源，那管不住用户已持久化的旧值。
- **高**：`MEDIUM_H` 回到 74（第一版一度加到 80 是为了给「控件单独一行 + 命中区」腾地方；
  控件改到歌名歌手右侧后就不需要了）。

**版式（用户指定）**：上排 `[封面][歌名 / 歌手][控件靠右]`，下排 `[进度条][时间]`。
- 控件在**歌名歌手两行块的右侧**、贴窗口右边（`margin-left:auto`），不单独占一行。
- 进度条与时间**同行**，条在前、时间在后。

**命中区仍然不与控件同行 —— 这是硬约束，不是审美**：
进度条的命中区必须比 3px 的条高得多才拖得准，而**命中区一旦伸到相邻行就会抢走那一行的点击**。
现在命中区是「下排」这一整行（14px），控件在「上排」，两者是**兄弟行**，物理上不可能重叠。

**悬浮态不能用负外边距撑命中区**（展开态那样做没问题，这里不行）：
悬浮态原来那版内容列在 `items-center` 的父级里，负外边距会被算进列高、把整列**推歪 3px**
（封面与文字列错位）。所以改用「固定高度的行」当命中区 —— 零位移。

**拖动期间不许收起**：悬浮态鼠标一移出就收起，而拖动进度条时指针很容易短暂移出岛体，
那会把拖动打断。`useScrub` 在拖动期间挂一个全局 hold（`isPointerHeld()`），
`Island.handleMouseLeave` 见到 hold 就不安排收起。

**控件**：上一首 / 播放暂停 / 下一首（18×18，播放键宽 22），点击 `stopPropagation()`
—— 悬浮态整块是可点的（点了进展开态），不拦冒泡会一次点击做两件事。
它们只报语义动作，走 `playbackControl` 的路由（SMTC 还是 Stage 由它决定）。

### 13.2 失焦态（minimal）背景丝线（2026-10-11 用户要求）

在 `MinimalContent` 的**有音乐分支**加了两条 `AudioWaveLine`（与展开态同一套「音频可视化」
语言，颜色取封面主色 = 光晕/进度条同源）。要点：

- 容器 `absolute inset-0` + `pointerEvents:none`，两条分别 `top:4%/height:46%` 与 `top:50%/height:46%`
- **三块内容（封面 / 信息列 / 时间）各自 `relative` + `zIndex:1`** ——
  带 z-index 的定位元素会盖住静态内容，省掉那三个 zIndex 会让丝线压到文字上面
- 岛体本身 `overflow:hidden`，胶囊两端的圆角自然裁掉越界部分
- 参数比展开态更克制（`opacityScale` 0.5 / 0.36）：失焦态只有 52px 高，丝线太亮会顶掉文字

**无音乐分支没加**：那里显示时间/天气，而丝线是音频可视化，且没有封面时主色会退化成
默认粉/蓝 —— 与内容无关的彩色波浪在那儿没有依据。要加的话另说。

`docs/music-layout.html` 已同步（悬浮态改成 340×80 含控件行与命中区、失焦态补上两段丝线）。

