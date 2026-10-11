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
