/**
 * 酷狗数据源 — 歌词 / 精确时长 / 专辑封面。
 *
 * 为什么需要它：
 * - 酷狗的 SMTC 会话不上报时间线（position/duration 恒为 0），时长必须另找来源；
 * - 中文/韩文歌在 LRCLIB 命中率低，而酷狗自有曲库必然匹配得上（就是播放器自己那首）；
 * - SMTC 封面读取在酷狗上会失败（cover_status=read-failed），酷狗搜索接口直接给封面模板。
 *
 * 参考 eIsland 的选源策略（detectProviderFromProcess → kugou）。
 */

import { fetch } from "@tauri-apps/plugin-http";
import type { LyricLine } from "../types/lyrics";
import { parseSyncedLrc } from "../utils/lrcParser";
import { b64ToUtf8 } from "../utils/base64";

const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

export interface KugouTrack {
  songname: string;
  singername: string;
  hash: string;
  albumId: string;
  /** 秒 */
  duration: number;
  /** 专辑封面（480px） */
  cover: string | null;
}

interface KugouSearchItem {
  songname?: string;
  singername?: string;
  hash?: string;
  album_id?: string;
  duration?: number;
  trans_param?: { union_cover?: string };
}

function pickCover(items: KugouSearchItem[], best: KugouSearchItem): string | null {
  // 优先用带 union_cover 模板的条目（酷狗真实专辑图，含日期路径）；
  // 同曲名的其它条目也纳入候选，避免选中的那条恰好没有 union_cover。
  const bestName = (best.songname || "").trim().toLowerCase();
  const candidates = [
    best,
    ...items.filter((i) => i !== best && (i.songname || "").trim().toLowerCase() === bestName),
  ];
  for (const it of candidates) {
    const tpl = it.trans_param?.union_cover;
    if (tpl) return tpl.replace("{size}", "480").replace(/^http:/, "https:");
  }
  if (best.album_id) return `https://imge.kugou.com/stdmusic/480/${best.album_id}.jpg`;
  return null;
}

/** 按「曲名 + 歌手」在酷狗搜索，返回最匹配的一首 */
export async function kugouLookup(title: string, artist: string): Promise<KugouTrack | null> {
  if (!title) return null;
  const keyword = `${title} ${artist || ""}`.trim();
  try {
    const resp = await fetch(
      `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=20&showtype=1`,
      { headers: HEADERS }
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: { info?: KugouSearchItem[] } };
    const list = json?.data?.info ?? [];
    if (list.length === 0) return null;

    // 匹配优先级：曲名完全相同 + 歌手吻合 > 曲名完全相同 > 曲名包含 > 第一条
    const lower = title.trim().toLowerCase();
    const artistLower = (artist || "").trim().toLowerCase();
    const sameName = list.filter((s) => (s.songname || "").trim().toLowerCase() === lower);
    const best =
      (artistLower &&
        sameName.find((s) => (s.singername || "").toLowerCase().includes(artistLower))) ||
      sameName[0] ||
      list.find((s) => (s.songname || "").toLowerCase().includes(lower)) ||
      list[0];

    return {
      songname: best.songname || title,
      singername: best.singername || artist || "",
      hash: best.hash || "",
      albumId: best.album_id || "",
      duration: typeof best.duration === "number" ? best.duration : 0,
      cover: pickCover(list, best),
    };
  } catch {
    return null;
  }
}

/**
 * 取酷狗同步歌词（LRC）。
 *
 * @param keyword 可选：调用方原始的「曲名 歌手」。不传则退化为匹配到的 songname/singername —
 *   后者带「- 电视剧版」这类后缀时，酷狗歌词接口会返回 0 候选（这是「有时拿不到歌词」的一个成因）。
 *
 * 对照 eIsland 的 kugou provider 另修两处：
 * - 时长未知时**不带 duration 参数**（原来恒定传 duration=0，接口会返回空候选）；
 * - 候选按序尝试最多 3 个：个别候选的 content 为空，换下一个就能拿到。
 */
export async function kugouLyrics(track: KugouTrack, keyword?: string): Promise<LyricLine[]> {
  if (!track.hash) return [];
  try {
    const kw = encodeURIComponent((keyword || `${track.songname} ${track.singername}`).trim());
    const durParam = track.duration > 0 ? `&duration=${Math.round(track.duration * 1000)}` : "";
    const searchResp = await fetch(
      `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${kw}${durParam}&hash=${track.hash}`,
      { headers: HEADERS }
    );
    if (!searchResp.ok) return [];
    const searchJson = (await searchResp.json()) as {
      candidates?: { id?: string | number; accesskey?: string }[];
    };
    const candidates = (searchJson?.candidates ?? []).filter((c) => c?.id && c?.accesskey);
    if (candidates.length === 0) return [];

    for (const cand of candidates.slice(0, 3)) {
      try {
        const dlResp = await fetch(
          `https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`,
          { headers: HEADERS }
        );
        if (!dlResp.ok) continue;
        const dlJson = (await dlResp.json()) as { content?: string };
        if (!dlJson?.content) continue;

        const lines = parseSyncedLrc(b64ToUtf8(dlJson.content));
        if (lines.length > 0) return lines;
      } catch {
        /* 换下一个候选 */
      }
    }
    return [];
  } catch {
    return [];
  }
}
