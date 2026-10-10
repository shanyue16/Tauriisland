/**
 * 酷狗歌词源 —— eIsland 的 kugou provider（搜索 → 歌词候选 → 下载 Base64 LRC）。
 *
 * 与 eIsland 的差异（都是为了修「有时拿不到」）：
 * ① 歌词搜索的 keyword 用**调用方原始的「曲名 歌手」**（eIsland 同），而不是匹配到的
 *    songname/singername —— 后者含「- 电视剧版」这类后缀时会让候选为空；
 * ② 候选按序尝试（最多 3 个 accesskey），前一个候选 content 为空就换下一个；
 * ③ hash/时长由外部传入时直接复用（useMusic 已经为封面/时长查过一次酷狗，不重复请求）。
 */

import { cleanArtist, cleanTitle } from "../../utils/lrcParser";
import { kugouLookup, kugouLyrics, type KugouTrack } from "../kugou";
import type { ProviderLyrics } from "./types";

async function lookup(
  title: string,
  artist: string,
  preset?: KugouTrack | null
): Promise<ProviderLyrics | null> {
  const track = preset ?? (await kugouLookup(title, artist));
  if (!track) return null;

  // 原始 keyword（而不是 track.songname/singername）：酷狗歌词接口按 keyword 匹配候选
  const keyword = `${title} ${artist}`.trim();
  const lines = await kugouLyrics(track, keyword);
  if (lines.length === 0) return null;

  return { lines, duration: track.duration > 0 ? track.duration : null };
}

export async function fetchLyricsFromKugou(
  title: string,
  artist: string,
  preset?: KugouTrack | null
): Promise<ProviderLyrics | null> {
  if (!title) return null;
  const raw = await lookup(title, artist, preset);
  if (raw) return raw;

  // 清洗后重试（复用已查到的曲目 hash，keyword 换成清洗后的名字）
  const cleanedTitle = cleanTitle(title);
  const cleanedArtist = cleanArtist(artist);
  if (cleanedTitle !== title || cleanedArtist !== artist) {
    return lookup(cleanedTitle, cleanedArtist, preset);
  }
  return null;
}
