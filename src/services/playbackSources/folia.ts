/**
 * Folia 本机歌词接口（默认 `http://127.0.0.1:32109/v1/lyric`）—— 只读的「本地歌词」源。
 *
 * ## 为什么它不是一个 `PlaybackSource`
 * `playbackSources/types.ts` 的 `PlaybackSource` 描述的是**能回答「现在在放什么」**的源
 * （Now Playing / Nexus / Stage）。Folia 这个接口**答不了**：它不给播放位置、不给封面、
 * 官方文档里的 `title` / `artist` 还是可选的（实测样本里就缺失）。
 * 它给的是「**Folia 自己正在放的那首歌**的歌词快照」—— 所以它只有一半能力：
 * 歌词，而且必须由调用方拿 SMTC 的曲目去核对身份才敢用。
 *
 * 硬塞进 `PlaybackSource` 会让接口变形（要么给 `fetch` 加一个别人不需要的 want 参数，
 * 要么返回一个 track 全是 null 的快照）。所以这里是一个**用途单一的模块**，
 * 入口只有两个：`fetchLyricsFromFolia(want)` 与诊断用的 `probeLocalLyric()`。
 *
 * ## 契约要点（来自 Folia 官方 docs/lyric-api.md + 本机实测）
 * - 无鉴权；**`200 OK` + JSON `null` 是正常态**（没在播 / 歌词加载中 / 无歌词），不是故障
 * - `lines[]` 是**按时间排序的歌词行**，**`lines[0]` 不保证是元数据行**
 * - 行/字时间是**秒**；顶层 `offset` 是**毫秒**
 * - `words` 永远存在（行级源会被 Folia 合成逐字时间）；
 *   `wordByWord` 只表示**原生逐字(true) vs 合成(false)** —— 不能拿「有没有 words」当判据
 * - 接口未启用 / 端口被占 = **连接失败、拿不到状态码**
 *
 * ## 接入三原则（见 docs/plan-playback-api-integration.md）
 * ① **曲目匹配**：与 SMTC 曲目对不上就整份丢弃（用 `isSameTrack`）
 * ② **可降级**：任何失败都必须静默返回 null，让 `lyrics.ts` 继续走原来的网络级联
 * ③ **过滤**：标题卡 / 零长度行 / `......` 占位行展示前都要去掉
 *
 * ## 静默 ≠ 无迹
 * 所有失败都静默降级，但**每一次尝试的结论都会记进 `status.ts`**，
 * 由「设置 → 歌曲 → 本地歌词接口」显示 —— 否则「没拿到逐字歌词」根本没法排查。
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useSettings } from "../../stores/settings";
import type { LyricLine, LyricWord } from "../../types/lyrics";
import { isSameArtist, isSameTrack, textMentionsTrack } from "../lyricsProviders/matcher";
import type { Candidate, ProviderLyrics, WantInfo } from "../lyricsProviders/types";
import { recordLocalLyricStatus } from "./status";

const LOG = "[Folia]";

/**
 * `......` 之类的前奏占位行（实测样本里出现过）
 */
const PLACEHOLDER = /^[.．。…·\s]+$/;

/**
 * 标题卡的分隔符写法**并不统一**：实测遇到过 `"曲名 - 歌手"`（两侧带空格）
 * 与 `"曲名-歌手"`（不带空格）两种 —— 只认带空格的那种会把整份歌词误判成
 * 「没有身份」而丢弃（曾因此让一首歌完全没有逐字歌词）。所以带空格的优先、
 * 再退化到各种裸符号。
 *
 * 宽松解析是安全的：切错了只会产出对不上身份的候选，被后面的门禁拒掉；
 * 真正的风险（把真实歌词行误当标题卡丢掉）由「歌手必须吻合」那一步兜住。
 */
const SEPARATORS = [" - ", " – ", " — ", "-", "–", "—", "－"];

/**
 * 把标题卡文本解析成候选 —— **两种先后顺序都产出**。
 *
 * 实测过三种写法，全都要认：
 *   `"曲名 - 歌手"`（有空格）、`"曲名-歌手"`（无空格）、
 *   **`"歌手 - 曲名"`（顺序颠倒！实测 `许嵩、黄龄 - 惊鸿一面`）**。
 * 少认一种就会把整份歌词判成「没有身份」而丢弃。
 *
 * 宽松解析是安全的：切错了只会产出对不上身份的候选，被后面的门禁拒掉；
 * 真正的风险（把真实歌词行误当标题卡丢掉）由「歌手必须吻合」那一步兜住。
 */
function identityCandidates(text: string): Candidate[] {
  const t = text.trim();
  if (!t) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (title: string, artists: string[]) => {
    if (!title || artists.length === 0) return;
    const key = `${title}|${artists.join("/")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: "lines[0]", title, artists });
  };

  for (const sep of SEPARATORS) {
    for (const idx of [t.indexOf(sep), t.lastIndexOf(sep)]) {
      if (idx <= 0) continue;
      const left = t.slice(0, idx).trim();
      const right = t
        .slice(idx + sep.length)
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!left || right.length === 0) continue;
      // 正序：<曲名> - <歌手>
      push(left, right);
      // 倒序：<歌手> - <曲名>（把右侧整体当曲名、左侧当歌手）
      push(right.join("/"), [left]);
    }
  }
  return out;
}

// ===== 原始响应形状（一律按 unknown 处理，防御式读取） =====

interface RawWord {
  text?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}
interface RawLine {
  text?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  words?: unknown;
  translation?: unknown;
  romanization?: unknown;
}
interface RawLyric {
  offset?: unknown;
  lines?: unknown;
  wordByWord?: unknown;
  title?: unknown;
  artist?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 秒 → 播放坐标的毫秒。官方公式：`歌词时间 = 播放时间(秒) − offset/1000`，反解即加回 offset。 */
function msOf(seconds: number, offsetMs: number): number {
  return Math.round(seconds * 1000) + offsetMs;
}

/** 当前设置（每次调用现读，改设置不需要重建任何东西） */
function readConfig() {
  const s = useSettings.getState().settings;
  return {
    enabled: s.localLyricEnabled,
    endpoint: s.localLyricEndpoint,
    timeoutMs: s.localLyricTimeoutMs,
    wordByWord: s.wordByWordEnabled,
  };
}

/** 从响应里读出「接口自己在放哪首歌」——顶层可选字段优先，缺失才看 lines[0] */
function readIdentity(raw: RawLyric, firstLineText: string): string | null {
  const t = str(raw.title).trim();
  const a = str(raw.artist).trim();
  if (t) return a ? `${t} / ${a}` : t;
  return firstLineText.trim() || null;
}

/**
 * 歌词时长是否与我们的曲长相容 —— 「曲名对不上」时的第二个身份依据。
 *
 * **为什么需要它**：歌词文件自带的标题（`lines[0]`）是**自由文本元数据**，
 * 实测会与播放器报的曲名不一致（同一首歌的另一种叫法），只看曲名会误杀 ——
 * 用户就永远拿不到逐字歌词。这不是该保守的地方，但也不能不设门槛。
 *
 * **为什么它可信**：歌词的时间轴是**按这一份录音**打出来的，所以「末行时间 vs 曲长」
 * 比曲名可靠得多。判据刻意不对称：
 * - **不能超**：歌词末行明显晚于曲终（+10s 以上）→ 这份歌词属于更长的录音，丢弃。
 * - **可以早**：尾奏/间奏常常没有人声，歌词比曲子短一截是常态，所以下限放得很松。
 * - 两侧缺任一个就不走这条路径（宁可不采用，也不冒险）。
 */
function isLengthCompatible(gotSpanMs: number | undefined, wantMs: number | undefined): boolean {
  if (!gotSpanMs || !wantMs) return false;
  return gotSpanMs <= wantMs + 10_000 && gotSpanMs >= wantMs * 0.5;
}

type FetchResult =  | { kind: "ok"; raw: RawLyric | null }
  | { kind: "error"; detail: string };

/**
 * 带**真超时**的 GET（不是 `Promise.race` 那种假超时 —— 请求会被真正 abort）。
 * 本机回环服务不该慢：没跑起来时 ECONNREFUSED 是毫秒级，界面不该为它等待。
 * 任何异常（abort / 半截 JSON / 连接被拒 / 被 ACL 挡）都归到 error。
 */
async function requestLyric(endpoint: string, timeoutMs: number): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await tauriFetch(endpoint, { signal: ctrl.signal });
    if (!resp.ok) return { kind: "error", detail: `HTTP ${resp.status}` };
    const json = (await resp.json()) as unknown;
    // 200 + null 是官方定义的正常态：没在播 / 加载中 / 无歌词
    if (json === null || typeof json !== "object") return { kind: "ok", raw: null };
    return { kind: "ok", raw: json as RawLyric };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return {
      kind: "error",
      detail: name === "AbortError" ? `超时 ${timeoutMs}ms` : (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function mapWords(raw: unknown, offsetMs: number): LyricWord[] {
  if (!Array.isArray(raw)) return [];
  const out: LyricWord[] = [];
  for (const w of raw as RawWord[]) {
    const text = str(w?.text);
    if (!text) continue;
    const start = num(w?.startTime);
    const end = num(w?.endTime);
    if (start === null || end === null) continue;
    // 零长度 word（标点）保留：它只是永远不会成为「正在唱」的那个，不需要插值
    out.push({ text, start_ms: msOf(start, offsetMs), end_ms: msOf(end, offsetMs) });
  }
  return out;
}

/** 取数 + 解析，不做曲目核对。返回 null 表示「这次没有可用歌词」。 */
async function loadRaw(cfg: ReturnType<typeof readConfig>) {
  const res = await requestLyric(cfg.endpoint, cfg.timeoutMs);
  if (res.kind === "error") return { error: res.detail } as const;
  if (res.raw === null) return { idle: true } as const;
  const raw = res.raw;
  const rawLines = Array.isArray(raw.lines) ? (raw.lines as RawLine[]) : [];
  if (rawLines.length === 0) return { idle: true } as const;
  return { raw, rawLines } as const;
}

/**
 * 取 Folia 的歌词并核对曲目身份。
 *
 * 命中（且确认是同一首歌）→ `ProviderLyrics`；其余一切情况（没在跑、没在播、
 * 放的是别的歌、只有占位行）→ `null`，让调用方继续走网络级联。
 * **永不抛异常。** 每次结果都会记进 `status.ts` 供设置页展示。
 */
export async function fetchLyricsFromFolia(want: WantInfo): Promise<ProviderLyrics | null> {
  const label = `${want.title} / ${want.artist}`;
  // 身份核对以曲名为准（空曲名的 titleScore 恒为 0），没曲名就别浪费这次请求
  if (!want.title) return null;

  // 时长是把「曲名对不上」判成人话的关键：同曲时它应当与 wantDurationMs 接近。
  // 每条 status 都带上，设置页据此自证是「放的不是同一首」还是「只是叫法不同」。
  const base = { want: label, wantDurationMs: want.durationMs };

  const cfg = readConfig();
  if (!cfg.enabled) {
    recordLocalLyricStatus({ ...base, outcome: "disabled", got: null });
    return null;
  }

  const loaded = await loadRaw(cfg);
  if ("error" in loaded) {
    recordLocalLyricStatus({ ...base, outcome: "unreachable", got: null, detail: loaded.error });
    return null;
  }
  if ("idle" in loaded) {
    recordLocalLyricStatus({ ...base, outcome: "idle", got: null });
    return null;
  }
  const { raw, rawLines } = loaded;
  const got = readIdentity(raw, str(rawLines[0]?.text));
  const lastEnd = num(rawLines[rawLines.length - 1]?.endTime);
  const gotSpanMs = lastEnd !== null ? Math.round(lastEnd * 1000) : undefined;
  const withGot = { ...base, got, gotSpanMs };

  // —— ① 身份核对：优先用官方可选字段，缺失才回退解析 lines[0] ——
  const topTitle = str(raw.title).trim();
  const topArtist = str(raw.artist).trim();
  const firstCandidates = identityCandidates(str(rawLines[0]?.text));
  const selfCandidates: Candidate[] = topTitle
    ? [{ id: "top", title: topTitle, artists: topArtist ? [topArtist] : [] }]
    : firstCandidates;

  // 路径 A（严格）：曲名 + 歌手（+ 时长）都对得上
  const strictCandidate = selfCandidates.some((c) => isSameTrack(c, want));
  // 路径 A 的兜底：**独立信号，不依赖解析结果**。
  // 分隔符、空格、`谁在前` 都列不全，所以只要 lines[0] 这段文本同时提到了
  // 我们的曲名与歌手就算数 —— 实测 `许嵩、黄龄 - 惊鸿一面`（顺序颠倒）
  // 就是靠这一步救回来的（解析出的候选顺序相反，两条结构化判据都不成立）。
  // 只在没有官方 title/artist 时才用：有官方字段就以它为准，
  // 否则「歌词行里出现歌名」这种正常情况会造成误判。
  const mentioned = !topTitle && textMentionsTrack(str(rawLines[0]?.text), want);
  const strict = strictCandidate || mentioned;
  // 路径 B（歌手 + 时长）：曲名对不上，但歌手强匹配**且**歌词时间跨度与曲长相容。
  // 实测案例：歌词自带的标题是「还在假装」，播放器与 Folia 放的却是「假装放下」——
  // 同一首歌、歌词源叫法不同。只走路径 A 会把它整份丢掉。
  const lenient =
    selfCandidates.some((c) => isSameArtist(c, want)) &&
    isLengthCompatible(gotSpanMs, want.durationMs);

  if (!strict && !lenient) {
    recordLocalLyricStatus({ ...withGot, outcome: "mismatch" });
    console.info(`${LOG} 曲目不匹配，丢弃（接口在放：${got ?? "未知"}）`);
    return null;
  }
  const byLength = !strictCandidate && !mentioned && lenient;

  // —— ② 标题卡过滤 ——
  // 只在第 0 行判定、且**必须内容吻合**才丢：官方明确 lines 是按时间排序的歌词行，
  // lines[0] 不保证是元数据。实测样本它都是标题卡，形如
  // "还在假装 - 刀酱"，而且**带真实时长与逐字时间轴**（0→0.6s），
  // 所以「零长度」「占位行」两类过滤都抓不到它，只能靠内容识别。
  // 判据 = 能解析出歌手**且歌手与我们吻合**（或整段文本同时提到曲名与歌手）：
  // 真正的歌词行几乎不会长成 "<某文本> - <我们的歌手>"，而标题卡一定会。
  // 这里刻意**不要求曲名也吻合** —— 本路径存在的理由就是曲名可能不一致。
  const metaIndex =
    mentioned ||
    firstCandidates.some((c) => isSameArtist(c, want) || isSameTrack(c, want))
      ? 0
      : -1;

  // —— ③ 换算 ——
  const offsetMs = num(raw.offset) ?? 0;
  // 逐字与否在这里一次性决定：不做逐字就把 words 丢掉。
  // 这样 UI 只需判「这一行有没有 words」，不必把一个布尔量穿透四层 props；
  // 判据是 wordByWord（原生 vs 合成），**不是**「有没有 words」—— 后者永远为真。
  const keepWords = raw.wordByWord === true && cfg.wordByWord;

  const lines: LyricLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (i === metaIndex) continue;
    const rl = rawLines[i];
    const text = str(rl?.text).trim();
    const start = num(rl?.startTime);
    const end = num(rl?.endTime);
    if (!text || start === null || end === null) continue;
    if (end <= start) continue; // 零长度行（推广行，如『听歌就在中国酷狗*星曜计划』）
    if (PLACEHOLDER.test(text)) continue;

    const timeMs = msOf(start, offsetMs);
    const line: LyricLine = { time_ms: timeMs, text };
    const endMs = msOf(end, offsetMs);
    if (endMs > timeMs) line.end_ms = endMs;
    // 官方字段，本接口确实会给；UI 暂未渲染（留给后续的翻译/音译展示）
    const translation = str(rl?.translation).trim();
    if (translation) line.translation = translation;
    const romanization = str(rl?.romanization).trim();
    if (romanization) line.romanization = romanization;
    if (keepWords) {
      const words = mapWords(rl?.words, offsetMs);
      if (words.length > 0) line.words = words;
    }

    lines.push(line);
  }

  if (lines.length === 0) {
    recordLocalLyricStatus({ ...withGot, outcome: "empty" });
    return null;
  }

  // 官方保证有序；getCurrentLyric 的二分依赖有序，防御式再排一次
  lines.sort((a, b) => a.time_ms - b.time_ms);

  recordLocalLyricStatus({
    ...withGot,
    outcome: "ok",
    // 说明白是哪条路径采用、以及有没有逐字 —— 否则「已命中但没逐字」又得猜一轮
    detail:
      [
        byLength ? "按歌手 + 时长吻合采用（歌词自带的曲名与播放器不一致）" : null,
        keepWords ? null : "这份歌词只有行级时间（wordByWord=false），未做逐字",
      ]
        .filter(Boolean)
        .join("；") || undefined,
  });
  console.info(
    `${LOG} 命中 "${label}"（${lines.length} 行，逐字=${keepWords}，offset=${offsetMs}ms，` +
      `${byLength ? "歌手+时长吻合" : "严格匹配"}）`
  );
  // Folia 不给时长（它不播音频，只镜像别的播放器）→ duration 交回调用方已有的来源
  return { lines, duration: null };
}

/**
 * 连通性探测 —— 只给设置页的「检测」按钮用。
 *
 * 与 `fetchLyricsFromFolia` 分开：探测**不关心曲目对不对**，
 * 只回答「这个地址现在能不能取到歌词」，这样用户能一眼分清是「服务没开」还是「放的不是同一首」。
 */
export async function probeLocalLyric(): Promise<{ ok: boolean; detail: string }> {
  const cfg = readConfig();
  if (!cfg.enabled) return { ok: false, detail: "已在设置里关闭" };
  const res = await requestLyric(cfg.endpoint, cfg.timeoutMs);
  if (res.kind === "error") return { ok: false, detail: res.detail };
  if (res.raw === null) return { ok: true, detail: "接口正常，但当前没有歌词（没在播 / 加载中）" };
  const rawLines = Array.isArray(res.raw.lines) ? (res.raw.lines as RawLine[]) : [];
  if (rawLines.length === 0) return { ok: true, detail: "接口正常，但当前没有歌词" };
  const identity = readIdentity(res.raw, str(rawLines[0]?.text));
  return {
    ok: true,
    detail: `接口正常，正在放：${identity ?? "未知"}（${rawLines.length} 行）`,
  };
}
