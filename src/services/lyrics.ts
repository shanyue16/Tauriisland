/**
 * 歌词获取 — 前端直连 LRCLIB（Tauri HTTP 白名单已放行 lrclib.net）。
 * 四策略搜索（精确 → 清洗后 → 模糊 → get），同时返回 LRCLIB duration（秒）。
 * LRCLIB 的 duration 是官方精确值，比 SMTC 上报可靠得多。
 */

import { fetch } from "@tauri-apps/plugin-http";
import type { LyricLine } from "../types/lyrics";
import { parseSyncedLrc } from "../utils/lrcParser";

const LRCLIB_HEADERS = {
  "User-Agent": "Tauriisland/2.0",
  Accept: "application/json",
};

interface LrcLibItem {
  trackName?: string;
  artistName?: string;
  duration?: number | null;
  syncedLyrics?: string | null;
}

export interface LyricsResult {
  lines: LyricLine[];
  /** LRCLIB 官方 duration（秒，精确），可能 null */
  duration: number | null;
}

function cleanTitle(t: string): string {
  return t
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 四策略 LRCLIB 搜索 */
async function lrclib_search(title: string, artist: string): Promise<LyricsResult | null> {
  // 策略 1 & 2: /api/search 精确
  for (const [t, a] of [
    [title, artist],
    [cleanTitle(title), artist],
  ]) {
    if (!t) continue;
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`;
    try {
      const resp = await fetch(url, { headers: LRCLIB_HEADERS });
      if (!resp.ok) continue;
      const items = (await resp.json()) as LrcLibItem[];
      if (items?.length) {
        for (const item of items) {
          if (item.syncedLyrics) {
            const lines = parseSyncedLrc(item.syncedLyrics);
            if (lines.length) {
              return { lines, duration: item.duration ?? null };
            }
          }
        }
      }
    } catch { /* 继续下一策略 */ }
  }

  // 策略 3: 模糊关键词
  const query = `${cleanTitle(title)} ${artist}`.trim();
  if (query) {
    try {
      const resp = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
        { headers: LRCLIB_HEADERS }
      );
      if (resp.ok) {
        const items = (await resp.json()) as LrcLibItem[];
        if (items?.length) {
          for (const item of items) {
            if (item.syncedLyrics) {
              const lines = parseSyncedLrc(item.syncedLyrics);
              if (lines.length) {
                return { lines, duration: item.duration ?? null };
              }
            }
          }
        }
      }
    } catch { /* 忽略 */ }
  }

  // 策略 4: /api/get 精确获取
  if (title) {
    try {
      const resp = await fetch(
        `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
        { headers: LRCLIB_HEADERS }
      );
      if (resp.ok) {
        const item = (await resp.json()) as LrcLibItem;
        if (item?.syncedLyrics) {
          const lines = parseSyncedLrc(item.syncedLyrics);
          if (lines.length) {
            return { lines, duration: item.duration ?? null };
          }
        }
      }
    } catch { /* 忽略 */ }
  }

  return null;
}

export async function fetchLyricsFromLrclib(
  title: string,
  artist: string
): Promise<LyricsResult | null> {
  if (!title) return null;
  try {
    return await lrclib_search(title, artist);
  } catch (e) {
    console.warn("[Lyrics] fetch error:", e);
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
