/**
 * Folia Stage API（默认 `http://127.0.0.1:32107`）—— **唯一能给出播放进度的本地源**。
 *
 * ## 它和另外几个源的关系
 * - `folia.ts`（32109 歌词接口）：只给歌词，**不给位置**。
 * - **本文件**（32107 Stage API）：给「Folia 自己那台播放器」的完整状态 ——
 *   曲名 / 歌手 / 专辑 / 时长 / **当前位置** / 播放状态 / 封面 / 队列，
 *   外加 `controlCapabilities`。它不给歌词。
 * - SMTC（`src-tauri/src/smtc.rs`）：**仍然是「现在在放什么」的权威**。
 *
 * ## 实测契约（2026-10-11，真机）
 * `GET /stage/health` → 200，**免鉴权**：
 *   `{"enabled":true,"modeEnabled":true,"source":"stage-api","port":32107,"activeEntryKind":null}`
 * 其余端点**一律要 `Authorization: Bearer <token>`**，否则 **401**：
 * - `GET /stage/player/status` → `{ current{id,source,title,artist,album,durationMs,coverUrl},
 *     playerState, positionMs, durationMs, sampledAtMs, updatedAt,
 *     controlCapabilities{play,pause,resume,seek,previous,next}, queueCapabilities{…}, queue{…} }`
 * - `GET /stage/player/time` → 只有 `{ playerState, positionMs, durationMs, sampledAtMs }`（很轻）
 * - `POST /stage/player/control` → 控制（本期**不用**，见下）
 *
 * 两个必须记住的实测细节：
 * 1. **`sampledAtMs` 是 Unix 毫秒**（与 `Date.now()` 同域，同一台机器同一个时钟）
 *    → 可以直接当「这一帧位置是在什么时候采的」用：`现在的位置 = positionMs + (Date.now() - sampledAtMs)`。
 * 2. **`current.coverUrl` 可能是 `blob:file:///…`** —— 那是 Folia 渲染进程内部的对象 URL，
 *    我们的 webview **取不到**。队列里的条目才是真的 `https://imge.kugou.com/…`。
 *    所以封面**不要**指望这个字段（`folia.ts` / 酷狗 / iTunes 那几条路继续兜底）。
 *
 * ## 为什么采纳门槛比 `folia.ts` 宽松
 * `folia.ts` 那边不匹配就**整份丢弃**：显示别人的歌词是明显错误，值得保守。
 * 这里不一样 —— 身份核对只是为了回答「这个位置数字属不属于这首正在放的歌」。
 * 猜错的代价只是**进度条偏一点**（下一轮 poll 就会自我纠正）；
 * 而误杀的代价是**这个功能永远不生效**（本项目已经为此栽过四次，见 commit 记录）。
 * 所以门槛是「曲名或歌手任一互相包含 + 时长相容」，而不是严格的 `isSameTrack`。
 *
 * ## 永不抛异常
 * 未启用 / 没填 token / 401 / 连不上 / 超时 / 畸形 JSON —— 一律返回 `null`，
 * 调用方静默沿用现有 SMTC 逻辑（界面与没有这个功能时**完全一致**）。
 */

import { useSettings } from "../../stores/settings";
import { norm } from "../lyricsProviders/matcher";
import { num, requestJson, str } from "./shared";
import { recordStageStatus } from "./status";

const LOG = "[Stage]";

/**
 * 「Stage 现在是不是当前这首歌的播放器」—— 由最近一次取数的核对结果驱动。
 *
 * 控制通道的安全性完全依赖这个判断：只有确认过「Stage 报的曲目就是我们正在放的这首」，
 * 才敢把用户的点击发到它那里。超过 `maxAgeMs` 没有新的核对通过就视为失效
 * （useMusic 每 500ms 取一次，2.5s 足够容忍几次丢包，又不会拿几分钟前的结论去点）。
 */
let matchedAt = 0;
let lastPlayerState: string | null = null;

function trackMatch(matched: boolean, playerState: string | null = null): void {
  matchedAt = matched ? Date.now() : 0;
  lastPlayerState = matched ? playerState : null;
}

/** 现在该不该把控制发给 Stage（而不是 SMTC） */
export function isStageControlActive(maxAgeMs = 2500): boolean {
  return matchedAt > 0 && Date.now() - matchedAt <= maxAgeMs;
}

/** Stage 报的播放状态（`PLAYING` / `PAUSED`）；没启用或没核对过时为 null */
export function stagePlayerState(): string | null {
  return isStageControlActive() ? lastPlayerState : null;
}

export interface StageSnapshot {
  title: string | null;
  artist: string | null;
  album: string | null;
  source: string | null;
  /** 播放器自报的总时长（ms） */
  durationMs: number;
  /** 当前位置（ms） */
  positionMs: number;
  /** **Unix 毫秒**：这一帧 positionMs 是什么时候采的（可直接与 Date.now() 相减） */
  sampledAtMs: number;
  /** `PLAYING` / `PAUSED` / 其他 */
  playerState: string | null;
  /** 该源声称自己支持哪些控制（本期只用于展示） */
  controlCapabilities: string[];
}

interface StageConfig {
  enabled: boolean;
  endpoint: string;
  token: string;
  timeoutMs: number;
}

function readConfig(): StageConfig {
  const s = useSettings.getState().settings;
  return {
    enabled: s.stageApiEnabled,
    endpoint: s.stageApiEndpoint,
    token: s.stageApiToken,
    timeoutMs: s.stageApiTimeoutMs,
  };
}

/** 归一化后互相包含 —— 太短的（<2 字）不算，避免「你」「我」这种假命中 */
function contains(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na.length < 2 || nb.length < 2) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * 这个 Stage 快照是不是「我们正在放的那首歌」。
 *
 * 判据刻意宽松（理由见文件头）：**曲名或歌手任一互相包含**，
 * 且**两边都报时长时必须相差 ≤15s**（同一首歌的不同版本/现场版常差这么多，再大就该怀疑是另一首）。
 */
export function stageMatchesTrack(
  snap: Pick<StageSnapshot, "title" | "artist" | "durationMs">,
  want: { title: string; artist: string; durationMs?: number }
): boolean {
  const titleOk = contains(snap.title ?? "", want.title);
  const artistOk = contains(snap.artist ?? "", want.artist);
  if (!titleOk && !artistOk) return false;

  const a = snap.durationMs;
  const b = want.durationMs ?? 0;
  if (a > 5000 && b > 5000 && Math.abs(a - b) > 15_000) return false;
  return true;
}

type FetchOutcome =
  | { kind: "ok"; snap: StageSnapshot | null }
  | { kind: "unauthorized" }
  | { kind: "error"; detail: string };

/**
 * 带**真超时**的 GET（不是 `Promise.race` 那种假超时 —— 请求会被真正 abort）。
 * 401 单独成一种结果：它是「token 没填对」，与「服务没跑」是完全不同的处置。
 */
async function requestStatus(cfg: StageConfig): Promise<FetchOutcome> {
  if (!cfg.token) return { kind: "unauthorized" };

  const url = `${cfg.endpoint.replace(/\/+$/, "")}/stage/player/status`;
  const r = await requestJson(url, cfg.timeoutMs, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (r.kind === "http") {
    if (r.status === 401 || r.status === 403) return { kind: "unauthorized" };
    return { kind: "error", detail: `HTTP ${r.status}` };
  }
  if (r.kind === "throw") {
    return { kind: "error", detail: r.timedOut ? `超时 ${cfg.timeoutMs}ms` : r.message };
  }

  const json = r.json;
  if (json === null || typeof json !== "object") return { kind: "ok", snap: null };
  const root = json as Record<string, unknown>;
  const cur = (root.current ?? null) as Record<string, unknown> | null;
  if (!cur || !str(cur.title)) return { kind: "ok", snap: null };

  const caps = (root.controlCapabilities ?? {}) as Record<string, unknown>;
  return {
    kind: "ok",
    snap: {
      title: str(cur.title) || null,
      artist: str(cur.artist) || null,
      album: str(cur.album) || null,
      source: str(cur.source) || null,
      durationMs: num(root.durationMs) ?? num(cur.durationMs) ?? 0,
      positionMs: num(root.positionMs) ?? 0,
      sampledAtMs: num(root.sampledAtMs) ?? 0,
      playerState: str(root.playerState) || null,
      controlCapabilities: Object.entries(caps)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    },
  };
}

/**
 * 取一份 Stage 快照，并**顺带完成与 SMTC 曲目的身份核对**。
 *
 * 返回 `{ snap, matched }`：
 * - `snap === null` → 这次没拿到（未启用 / 401 / 连不上 / 没有在放的东西），调用方不要改任何东西
 * - `matched === false` → 拿到了，但**不是我们这首** → 调用方**不要采纳它的进度**
 * - `matched === true` → 可以采纳（`positionMs` / `sampledAtMs` / `durationMs`）
 *
 * **永不抛异常。** 每次结果都会记进 `status.ts` 供设置页展示。
 */
export async function fetchStageSnapshot(want: {
  title: string;
  artist: string;
  durationMs?: number;
}): Promise<{ snap: StageSnapshot; matched: boolean } | null> {
  const label = `${want.title} / ${want.artist}`;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.token) {
    // 不记 status：没开就不该在面板上留下噪音（面板自己会显示「已关闭」）
    trackMatch(false);
    return null;
  }

  const base = { want: label, wantDurationMs: want.durationMs };
  const res = await requestStatus(cfg);

  if (res.kind === "unauthorized") {
    trackMatch(false);
    recordStageStatus({ ...base, outcome: "unauthenticated", got: null });
    return null;
  }
  if (res.kind === "error") {
    trackMatch(false);
    recordStageStatus({ ...base, outcome: "unreachable", got: null, detail: res.detail });
    return null;
  }
  if (res.snap === null) {
    trackMatch(false);
    recordStageStatus({ ...base, outcome: "idle", got: null });
    return null;
  }

  const snap = res.snap;
  const got = snap.artist ? `${snap.title} / ${snap.artist}` : (snap.title ?? "未知");
  const matched = stageMatchesTrack(snap, want);
  trackMatch(matched, snap.playerState);
  recordStageStatus({
    ...base,
    outcome: matched ? "ok" : "mismatch",
    got,
    gotDurationMs: snap.durationMs || undefined,
    positionMs: snap.positionMs,
    playerState: snap.playerState,
    matched,
    detail: matched
      ? undefined
      : "曲名与歌手都对不上，未采纳它的进度（只用于展示）",
  });
  if (!matched) {
    console.info(`${LOG} 曲目对不上，未采纳进度（接口在放：${got}）`);
  }
  return { snap, matched };
}

// ————————————————————————————————————————————————————————————————
// 控制（第二个通道）
// ————————————————————————————————————————————————————————————————

/**
 * 官方 `StagePlayerControlRequest.action` 的允许枚举。
 * **注意没有 `play`** —— 起播要发 `resume`（`controlCapabilities.play` 是另一回事）。
 */
export type StageControlAction = "next" | "prev" | "pause" | "resume" | "seek";

/**
 * 控制结果。**必须区分「明确被拒」和「结果未知」**：
 * - `rejected: true`（4xx：动作不支持 / 参数非法）→ 指令**确定没有生效**，调用方可以安全回退到 SMTC
 * - `rejected: false`（5xx / 超时 / 网络错）→ **不知道有没有生效**，回退会冒「双动作」的险
 *   （例如 pause 其实成功了但响应丢了，再发一次 SMTC toggle 反而把它恢复播放），所以不回退
 */
export type StageControlResult =
  | { ok: true }
  | { ok: false; rejected: boolean; detail: string };

/**
 * 向 Stage API 发一条控制指令。
 *
 * 只在 `isStageControlActive()` 为真时才会被调用（由 `services/playbackControl.ts` 负责），
 * 因为只有核对过「Stage 报的曲目就是我们正在放的这首」才敢把用户的点击发过去。
 * **永不抛异常。**
 */
export async function sendStageControl(
  action: StageControlAction,
  positionMs?: number
): Promise<StageControlResult> {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.token) return { ok: false, rejected: true, detail: "未启用" };

  const url = `${cfg.endpoint.replace(/\/+$/, "")}/stage/player/control`;
  const body: Record<string, unknown> = { action };
  if (action === "seek") {
    // 官方要求：非负整数，服务端向下取整
    body.positionMs = Math.max(0, Math.floor(positionMs ?? 0));
  }

  const r = await requestJson(url, cfg.timeoutMs, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (r.kind === "http") {
    // 4xx = 明确拒绝（没生效）；5xx = 结果未知
    const rejected = r.status >= 400 && r.status < 500;
    let detail = `HTTP ${r.status}`;
    if (r.bodyText) {
      try {
        const err = JSON.parse(r.bodyText) as { error?: unknown; code?: unknown };
        const code = typeof err?.code === "string" ? err.code : "";
        const msg = typeof err?.error === "string" ? err.error : "";
        if (code || msg) detail = `${r.status} ${code || msg}`;
      } catch {
        /* 错误体不是 JSON 也无所谓 */
      }
    }
    console.info(`${LOG} 控制 ${action} 被拒：${detail}`);
    return { ok: false, rejected, detail };
  }
  if (r.kind === "throw") {
    const detail = r.timedOut ? `超时 ${cfg.timeoutMs}ms` : r.message;
    console.info(`${LOG} 控制 ${action} 失败：${detail}`);
    return { ok: false, rejected: false, detail };
  }

  const json = r.json as { accepted?: unknown } | null;
  if (json && json.accepted === true) return { ok: true };
  // 200 但没 accepted:true —— 视为未生效，但**不**当作明确拒绝（写清楚了才知道发生了什么）
  return { ok: false, rejected: false, detail: "响应里没有 accepted" };
}
