/**
 * 歌词获取 —— 多源级联，方式与 eIsland（src/renderer/api/lyrics/lrcs）一致：
 *
 *   ⓪ 本地源（Folia 本机歌词接口 127.0.0.1:32109）—— 就在回环上，命中即返回
 *   ① 按 SMTC 来源进程选「主源」（detectProviderFromApp，对应 eIsland 的 PROCESS_TO_PROVIDER）
 *   ② 主源 → 其余源依次回退（ALL_PROVIDERS 顺序同 eIsland：netease → qqmusic → kugou）
 *   ③ 全部失败才落到 LRCLIB 兜底
 *
 * 为什么换掉「酷狗 + LRCLIB」两源：中文歌在 LRCLIB 命中率低，一旦播放器自带的源（网易云/QQ）
 * 或酷狗那边关键字不匹配，就直接空手而归 —— 这是「有时获取不到歌词」的主因。
 *
 * 为什么本地源排在最前：它给的是「曲目级 + 逐字」的歌词（岛上唯一能做卡拉OK的来源），
 * 且就在回环上；命中时整条网络级联一次都不用发。不可用/曲目对不上时由
 * `playbackSources/folia.ts` 自行静默返回 null，代价只有一次毫秒级失败。
 *
 * 另外每个源都有 cleanTitle/cleanArtist 二次重试（eIsland 同款），并且单请求 6s 超时，
 * 避免某个源卡住把整条级联拖死。
 */

import type { LyricLine } from "../types/lyrics";
import type { KugouTrack } from "./kugou";
import { fetchLyricsFromKugou } from "./lyricsProviders/kugou";
import { fetchLyricsFromLrclib as lrclibProvider } from "./lyricsProviders/lrclib";
import { fetchLyricsFromNetease } from "./lyricsProviders/netease";
import { fetchLyricsFromQQMusic } from "./lyricsProviders/qqmusic";
import type { ProviderLyrics } from "./lyricsProviders/types";
import { fetchLyricsFromFolia } from "./playbackSources/folia";

export type LyricsProvider = "netease" | "qqmusic" | "kugou" | "lrclib" | "folia";

export interface LyricsResult {
  lines: LyricLine[];
  /** 该源给出的精确时长（秒）；无则 null */
  duration: number | null;
  /** 命中来源（诊断用） */
  provider?: LyricsProvider;
}

export interface LyricsQuery {
  title: string;
  artist: string;
  /** SMTC 来源应用（AUMID 或显示名），用于选主源 */
  appName?: string | null;
  /** 已经查到过的酷狗曲目：复用 hash/时长，省一次搜索 */
  kugouTrack?: KugouTrack | null;
  /**
   * 已知时长（毫秒）—— 只用于给本地源做**曲目核对**打分（时长是打分项之一）。
   * 拿不到就别传：matcher 对缺时长的候选给中性分，不会因此误判。
   */
  durationMs?: number;
}

const LOG = "[Lyrics]";

/**
 * 与 eIsland 的 PROCESS_TO_PROVIDER 对齐（只保留本项目实现的源）。
 * app_name 来自 SMTC 的 SourceAppUserModelId，正常是 "CloudMusic.exe" / "QQMusic.exe" /
 * "KuGou.exe" 这类 AUMID；后面那几个中文/别名分支是兜底（个别播放器会报显示名）。
 */
const PROCESS_TO_PROVIDER: Array<{ pattern: RegExp; provider: LyricsProvider }> = [
  { pattern: /cloudmusic|netease|网易云/i, provider: "netease" },
  { pattern: /qqmusic|qq音乐/i, provider: "qqmusic" },
  { pattern: /kugou|酷狗/i, provider: "kugou" },
];

/** eIsland 的 ALL_PROVIDERS 顺序（去掉本项目未实现的汽水/Apple/Spotify/MoeKoe） */
const ALL_PROVIDERS: LyricsProvider[] = ["netease", "qqmusic", "kugou"];

/** 单请求超时：卡住的源不能拖住整条级联 */
const PER_REQUEST_TIMEOUT = 6000;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), PER_REQUEST_TIMEOUT)),
  ]);
}

/** 时长合理性闸门：5s~3600s 之外的一律判无效（防某个源单位不对把进度条搞坏） */
function saneDuration(seconds: number | null | undefined): number | null {
  if (!seconds || !isFinite(seconds)) return null;
  return seconds >= 5 && seconds <= 3600 ? seconds : null;
}

export function detectProviderFromApp(appName: string | null | undefined): LyricsProvider | null {
  if (!appName) return null;
  const matched = PROCESS_TO_PROVIDER.find(({ pattern }) => pattern.test(appName));
  return matched?.provider ?? null;
}

function runProvider(
  provider: LyricsProvider,
  title: string,
  artist: string,
  kugouTrack?: KugouTrack | null
): Promise<ProviderLyrics | null> {
  switch (provider) {
    case "netease":
      return fetchLyricsFromNetease(title, artist);
    case "qqmusic":
      return fetchLyricsFromQQMusic(title, artist);
    case "kugou":
      return fetchLyricsFromKugou(title, artist, kugouTrack);
    default:
      return Promise.resolve(null);
  }
}

/**
 * 多源级联取歌词。命中即返回；全部失败返回 null（调用方自行决定空态）。
 */
export async function fetchLyricsMulti(query: LyricsQuery): Promise<LyricsResult | null> {
  const { title, artist, appName, kugouTrack, durationMs } = query;
  if (!title && !artist) return null;

  // ⓪ 本地源（Folia 本机歌词接口）—— 放在整条级联之前。
  // 它自己负责：曲目核对（对不上整份丢弃）、真超时、一切失败静默返回 null，
  // 所以这里不需要再包一层 withTimeout（那是假的超时，不会中止请求）。
  const local = await fetchLyricsFromFolia({ title, artist, durationMs });
  if (local && local.lines.length > 0) {
    console.info(`${LOG} 命中 folia(本地): "${title} / ${artist}"（${local.lines.length} 行）`);
    return { lines: local.lines, duration: saneDuration(local.duration), provider: "folia" };
  }

  const primary = detectProviderFromApp(appName);
  const order = primary ? [primary, ...ALL_PROVIDERS.filter((p) => p !== primary)] : ALL_PROVIDERS;

  for (const provider of order) {
    const hit = await withTimeout(runProvider(provider, title, artist, kugouTrack), null);
    if (hit && hit.lines.length > 0) {
      console.info(`${LOG} 命中 ${provider}: "${title} / ${artist}"（${hit.lines.length} 行）`);
      return { lines: hit.lines, duration: saneDuration(hit.duration), provider };
    }
    console.warn(`${LOG} ${provider} 未命中: "${title} / ${artist}"`);
  }

  // 最后一档：LRCLIB（eIsland 同样放在所有源之后）
  const lr = await withTimeout(lrclibProvider(title, artist), null);
  if (lr && lr.lines.length > 0) {
    console.info(`${LOG} 命中 lrclib（兜底）: "${title} / ${artist}"（${lr.lines.length} 行）`);
    return { lines: lr.lines, duration: saneDuration(lr.duration), provider: "lrclib" };
  }

  console.warn(`${LOG} 全部源都未命中: "${title} / ${artist}"`);
  return null;
}

/** 兼容旧调用：只走 LRCLIB */
export async function fetchLyricsFromLrclib(
  title: string,
  artist: string
): Promise<LyricsResult | null> {
  if (!title) return null;
  try {
    const r = await lrclibProvider(title, artist);
    return r && r.lines.length > 0
      ? { lines: r.lines, duration: saneDuration(r.duration), provider: "lrclib" }
      : null;
  } catch (e) {
    console.warn("[Lyrics] LRCLIB error:", e);
    return null;
  }
}

/**
 * 二分查找当前歌词行（O(log n)）。
 */
export function getCurrentLyric(
  lyrics: LyricLine[],
  positionMs: number
): LyricLine | null {
  const n = lyrics.length;
  if (n === 0) return null;
  if (positionMs < lyrics[0].time_ms) return null;
  if (positionMs >= lyrics[n - 1].time_ms) return lyrics[n - 1];

  let lo = 0, hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = lyrics[mid].time_ms;
    if (t <= positionMs && (mid === n - 1 || lyrics[mid + 1].time_ms > positionMs)) {
      return lyrics[mid];
    }
    if (t > positionMs) hi = mid - 1;
    else lo = mid + 1;
  }
  return lyrics[Math.max(0, lo - 1)];
}
