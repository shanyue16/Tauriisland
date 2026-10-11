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
 * 入口只有一个：`fetchLyricsFromFolia(want)`。
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
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { LyricLine, LyricWord } from "../../types/lyrics";
import { isSameTrack } from "../lyricsProviders/matcher";
import type { Candidate, ProviderLyrics, WantInfo } from "../lyricsProviders/types";

/**
 * 默认端点。**P1 阶段先用常量**；等「设置」那一步落地后改为读
 * `settings.localLyricEndpoint`（并加 `localLyricEnabled` 开关）。
 */
const ENDPOINT = "http://127.0.0.1:32109/v1/lyric";

/**
 * 真超时（不是 `Promise.race` 那种假超时 —— 请求会被真正 abort）。
 * 本机回环服务不该慢：没跑起来时 ECONNREFUSED 是毫秒级，界面不该为它等待。
 */
const TIMEOUT_MS = 1200;

const LOG = "[Folia]";

/** `......` 之类的前奏占位行（实测样本里出现过） */
const PLACEHOLDER = /^[.．。…·\s]+$/;

/** 曲名与歌手的官方分隔符 */
const SEP = " - ";

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

/**
 * 把 `"<曲名> - <歌手1>/<歌手2>"` 解析成候选。
 *
 * 首尾两个 ` - ` 各给一个切点：曲名自己可能含 ` - `，
 * 由调用方用 `isSameTrack` 挑出真正吻合的那个（都不吻合就整份丢弃）。
 */
function identityCandidates(text: string): Candidate[] {
  const t = text.trim();
  if (!t) return [];
  const out: Candidate[] = [];
  for (const idx of [t.indexOf(SEP), t.lastIndexOf(SEP)]) {
    if (idx <= 0) continue;
    const title = t.slice(0, idx).trim();
    if (!title || out.some((c) => c.title === title)) continue;
    const artists = t
      .slice(idx + SEP.length)
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ id: "lines[0]", title, artists });
  }
  return out;
}

/** 带真超时的 GET。任何异常（含 abort / 半截 JSON / 连接被拒）都归到 null。 */
async function requestLyric(): Promise<RawLyric | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await tauriFetch(ENDPOINT, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as unknown;
    // 200 + null 是官方定义的正常态：没在播 / 加载中 / 无歌词
    if (json === null || typeof json !== "object") return null;
    return json as RawLyric;
  } catch {
    // 未启用 / 端口被占 = 连接失败；半截 JSON = 解析失败。都属于「静默降级」范畴。
    return null;
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

/**
 * 取 Folia 的歌词并核对曲目身份。
 *
 * 命中（且确认是同一首歌）→ `ProviderLyrics`；其余一切情况（没在跑、没在播、
 * 放的是别的歌、只有占位行）→ `null`，让调用方继续走网络级联。
 * **永不抛异常。**
 */
export async function fetchLyricsFromFolia(want: WantInfo): Promise<ProviderLyrics | null> {
  // 身份核对以曲名为准（空曲名的 titleScore 恒为 0），没曲名就别浪费这次请求
  if (!want.title) return null;

  const raw = await requestLyric();
  if (!raw) return null;

  const rawLines = Array.isArray(raw.lines) ? (raw.lines as RawLine[]) : [];
  if (rawLines.length === 0) return null;

  const topTitle = str(raw.title).trim();
  const topArtist = str(raw.artist).trim();

  // —— ① 身份核对：优先用官方可选字段，缺失才回退解析 lines[0] ——
  if (topTitle) {
    const ok = isSameTrack(
      { id: "top", title: topTitle, artists: topArtist ? [topArtist] : [] },
      want
    );
    if (!ok) {
      console.info(`${LOG} 曲目不匹配（Folia 在放别的歌），丢弃`);
      return null;
    }
  } else {
    const first = identityCandidates(str(rawLines[0]?.text));
    if (!first.some((c) => isSameTrack(c, want))) {
      console.info(`${LOG} 曲目不匹配（无法确认 Folia 放的就是这首歌），丢弃`);
      return null;
    }
  }

  // —— ② 标题卡过滤 ——
  // 只在第 0 行判定、且**必须内容吻合**才丢：官方明确 lines 是按时间排序的歌词行，
  // lines[0] 不保证是元数据。实测两次样本它都是标题卡，形如
  // "ひとり旅 - 瀬名航/鎖那 (さな)"，而且**带真实时长与逐字时间轴**（0→0.608s），
  // 所以「零长度」「占位行」两类过滤都抓不到它，只能靠曲目评分识别。
  const metaCandidates = identityCandidates(str(rawLines[0]?.text));
  const metaIndex = metaCandidates.some((c) => isSameTrack(c, want)) ? 0 : -1;

  // —— ③ 换算 ——
  const offsetMs = num(raw.offset) ?? 0;
  // 逐字与否在这里一次性决定：不做逐字就把 words 丢掉。
  // 这样 UI 只需判「这一行有没有 words」，不必把一个布尔量穿透四层 props；
  // 判据是 wordByWord（原生 vs 合成），**不是**「有没有 words」—— 后者永远为真。
  // 设置接入后这里再与 settings.wordByWordEnabled 相与。
  const nativeWordByWord = raw.wordByWord === true;

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
    if (nativeWordByWord) {
      const words = mapWords(rl?.words, offsetMs);
      if (words.length > 0) line.words = words;
    }

    lines.push(line);
  }

  if (lines.length === 0) return null;

  // 官方保证有序；getCurrentLyric 的二分依赖有序，防御式再排一次
  lines.sort((a, b) => a.time_ms - b.time_ms);

  console.info(
    `${LOG} 命中 "${want.title} / ${want.artist}"（${lines.length} 行，原生逐字=${nativeWordByWord}，offset=${offsetMs}ms）`
  );
  // Folia 不给时长（它不播音频，只镜像别的播放器）→ duration 交回调用方已有的来源
  return { lines, duration: null };
}
