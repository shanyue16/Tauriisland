/**
 * QQ 音乐歌词源 —— 移植 eIsland 的 qqmusic provider（含 JSONP / Base64 处理）。
 *
 * 流程：POST u.y.qq.com/cgi-bin/musicu.fcg 搜歌（page1 → page2 → shc 备用接口）
 *      → 打分挑最匹配的一首 → POST c.y.qq.com lyric JSONP 接口 → Base64(UTF-8) 解出 LRC。
 * 与 eIsland 的差异：只用标准 LRC（本项目不做逐字/翻译），并保留 cleanTitle/cleanArtist 重试。
 */

import { fetch } from "@tauri-apps/plugin-http";
import { cleanArtist, cleanTitle, parseSyncedLrc } from "../../utils/lrcParser";
import { b64ToUtf8 } from "../../utils/base64";
import { pickBest } from "./matcher";
import type { Candidate, ProviderLyrics } from "./types";

const QQ_HEADERS: Record<string, string> = {
  Referer: "https://c.y.qq.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** 主搜索接口（page 1 → page 2 由调用方控制） */
async function searchPrimary(query: string, page: string): Promise<Candidate[]> {
  try {
    const resp = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...QQ_HEADERS },
      body: JSON.stringify({
        req_1: {
          method: "DoSearchForQQMusicDesktop",
          module: "music.search.SearchCgiService",
          param: { num_per_page: "20", page_num: page, query, search_type: 0 },
        },
      }),
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as Record<string, any>;
    const list = json?.req_1?.data?.body?.song?.list;
    if (!Array.isArray(list)) return [];
    return list.map((s: any) => ({
      id: String(s.mid ?? ""),
      title: String(s.title ?? s.name ?? ""),
      artists: Array.isArray(s.singer) ? s.singer.map((x: any) => String(x.title ?? x.name ?? "")) : [],
      album: s.album?.title ?? s.album?.name ?? "",
      durationMs: typeof s.interval === "number" ? s.interval * 1000 : undefined,
    }));
  } catch {
    return [];
  }
}

/** 备用搜索接口（eIsland 的 searchFallback） */
async function searchFallback(query: string): Promise<Candidate[]> {
  const url =
    "https://shc.y.qq.com/soso/fcgi-bin/search_for_qq_cp?_=1657641526460&g_tk=1037878909&uin=1804681355" +
    "&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&zhidaqu=1&catZhida=1" +
    `&t=0&flag=1&ie=utf-8&sem=&aggr=0&perpage=20&n=20&p=1&remoteplace=txt.mqq.all&w=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, { headers: QQ_HEADERS });
    if (!resp.ok) return [];
    const json = (await resp.json()) as Record<string, any>;
    const list = json?.data?.song?.list;
    if (!Array.isArray(list)) return [];
    return list.map((s: any) => ({
      id: String(s.songmid ?? ""),
      title: String(s.songname ?? ""),
      artists: Array.isArray(s.singer) ? s.singer.map((x: any) => String(x.name ?? "")) : [],
      album: s.albumname ?? "",
      durationMs: typeof s.interval === "number" ? s.interval * 1000 : undefined,
    }));
  } catch {
    return [];
  }
}

async function searchAll(query: string): Promise<Candidate[]> {
  let list = await searchPrimary(query, "1");
  if (list.length > 0) return list;
  list = await searchPrimary(query, "2");
  if (list.length > 0) return list;
  return searchFallback(query);
}

/** 取 LRC：JSONP 外壳 + Base64(UTF-8) */
async function fetchLrc(songMid: string): Promise<ProviderLyrics | null> {
  if (!songMid) return null;
  const callback = "MusicJsonCallback_lrc";
  const params = new URLSearchParams({
    callback,
    pcachetime: Date.now().toString(),
    songmid: songMid,
    g_tk: "5381",
    jsonpCallback: callback,
    loginUin: "0",
    hostUin: "0",
    format: "jsonp",
    inCharset: "utf8",
    outCharset: "utf8",
    notice: "0",
    platform: "yqq",
    needNewCode: "0",
  });

  try {
    const resp = await fetch("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://y.qq.com/",
        "User-Agent": "Mozilla/5.0",
      },
      body: params.toString(),
    });
    if (!resp.ok) return null;
    const raw = await resp.text();
    const prefix = `${callback}(`;
    if (!raw.startsWith(prefix)) return null;
    const jsonStr = raw.slice(prefix.length, raw.endsWith(")") ? raw.length - 1 : raw.length);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const lyricB64 = typeof parsed.lyric === "string" ? parsed.lyric : "";
    if (!lyricB64) return null;
    const lines = parseSyncedLrc(b64ToUtf8(lyricB64));
    return lines.length > 0 ? { lines, duration: null } : null;
  } catch {
    return null;
  }
}

async function lookup(title: string, artist: string): Promise<ProviderLyrics | null> {
  const query = `${title} ${artist}`.trim();
  const candidates = await searchAll(query);
  if (candidates.length === 0) return null;
  const best = pickBest(candidates, { title, artist });
  if (!best?.id) return null;
  const result = await fetchLrc(best.id);
  if (!result) return null;
  const duration = best.durationMs && best.durationMs > 0 ? Math.round(best.durationMs / 100) / 10 : null;
  return { lines: result.lines, duration };
}

export async function fetchLyricsFromQQMusic(
  title: string,
  artist: string
): Promise<ProviderLyrics | null> {
  if (!title) return null;
  const raw = await lookup(title, artist);
  if (raw) return raw;

  const cleanedTitle = cleanTitle(title);
  const cleanedArtist = cleanArtist(artist);
  if (cleanedTitle !== title || cleanedArtist !== artist) {
    return lookup(cleanedTitle, cleanedArtist);
  }
  return null;
}
