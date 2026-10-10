/**
 * LRCLIB 歌词源 —— 永远是多源级联的最后一档兜底（与 eIsland 一致）。
 *
 * 四策略搜索：精确(track_name/artist_name) → 清洗后精确 → 模糊 q → /api/get。
 * LRCLIB 的 duration 是官方精确值，一并带回（时长优先级链会用到）。
 */

import { fetch } from "@tauri-apps/plugin-http";
import { cleanArtist, cleanTitle, parseSyncedLrc } from "../../utils/lrcParser";
import type { ProviderLyrics } from "./types";

const HEADERS = {
  "User-Agent": "Tauriisland/2.0",
  Accept: "application/json",
};

interface LrcLibItem {
  trackName?: string;
  artistName?: string;
  duration?: number | null;
  syncedLyrics?: string | null;
}

/** 从搜索结果里取第一条带 syncedLyrics 的 */
function fromList(items: unknown): ProviderLyrics | null {
  if (!Array.isArray(items)) return null;
  for (const raw of items as LrcLibItem[]) {
    if (!raw?.syncedLyrics) continue;
    const lines = parseSyncedLrc(raw.syncedLyrics);
    if (lines.length > 0) {
      return { lines, duration: typeof raw.duration === "number" ? raw.duration : null };
    }
  }
  return null;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function fetchLyricsFromLrclib(
  title: string,
  artist: string
): Promise<ProviderLyrics | null> {
  if (!title) return null;

  // 策略 1 & 2：精确曲名 + 清洗后曲名
  for (const [t, a] of [
    [title, artist],
    [cleanTitle(title), cleanArtist(artist)],
  ]) {
    if (!t) continue;
    const json = await getJson(
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`
    );
    const hit = fromList(json);
    if (hit) return hit;
  }

  // 策略 3：模糊关键词
  const query = `${cleanTitle(title)} ${cleanArtist(artist)}`.trim();
  if (query) {
    const hit = fromList(await getJson(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`));
    if (hit) return hit;
  }

  // 策略 4：/api/get 精确获取
  const single = (await getJson(
    `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle(title))}&artist_name=${encodeURIComponent(cleanArtist(artist))}`
  )) as LrcLibItem | null;
  if (single?.syncedLyrics) {
    const lines = parseSyncedLrc(single.syncedLyrics);
    if (lines.length > 0) {
      return { lines, duration: typeof single.duration === "number" ? single.duration : null };
    }
  }

  return null;
}
