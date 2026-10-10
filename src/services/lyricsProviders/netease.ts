/**
 * 网易云音乐歌词源 —— 移植 eIsland 的 netease provider，并适配网易云新接口的歌词格式。
 *
 * 流程：POST /api/search/get/web 搜歌（20 条候选 + 打分挑最匹配的一首）
 *      → POST interface3 /api/song/lyric/v1 取歌词 → cleanTitle/cleanArtist 重试一次。
 *
 * ⚠️ 实测（2026-10-10）：`interface3 /api/song/lyric/v1` 现在把 `lrc.lyric` 返回成
 * **「每行一个 JSON 对象」的文本**，而不是标准 LRC：
 *     {"t":12340,"c":[{"tx":"这一路上走走停停"}]}
 *   （t = 毫秒时间戳，c[].tx = 该行的文本片段；yrc 字段已不再返回）
 * eIsland 只按 LRC/YRC 解析，遇到这种响应会得到 0 行 —— 这正是「有时拿不到歌词」的一大成因。
 * 这里两种格式都吃：先按标准 LRC 解析，0 行再按上面的 JSON 格式解析。
 */

import { fetch } from "@tauri-apps/plugin-http";
import type { LyricLine } from "../../types/lyrics";
import { cleanArtist, cleanTitle, parseSyncedLrc } from "../../utils/lrcParser";
import { pickBest } from "./matcher";
import type { Candidate, ProviderLyrics } from "./types";

const HEADERS: Record<string, string> = {
  Referer: "https://music.163.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Content-Type": "application/x-www-form-urlencoded",
};

interface NeteaseSong {
  id?: number | string;
  name?: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  /** 毫秒 */
  duration?: number;
}

/**
 * 网易云「逐行 JSON」歌词格式 → LyricLine[]。
 * 同时兼容两种形态：整段是 JSON 数组，或每行一个 JSON 对象（实测是后者）。
 *
 * 实测这个 JSON 段落里装的常常只是**署名行**（作词/作曲/编曲/特别支持…），正文歌词仍在
 * 标准 LRC 段里 —— 所以调用方是「LRC 优先、JSON 兜底」，这里再把纯署名行滤掉：
 * 若兜底路径只剩署名，就返回空，让级联继续走下一个源，而不是把署名当歌词显示。
 */
const CREDIT_RE =
  /^(作词|作曲|编曲|制作人|制作|出品|监制|录音|混音|母带|吉他|贝斯|鼓|键盘|弦乐|和声|配唱|统筹|企划|发行|特别支持|词|曲)\s*[:：]/;

function parseNeteaseJsonLyric(text: string): LyricLine[] {
  const entries: Array<{ t?: number; c?: Array<{ tx?: string }> }> = [];
  const whole = text.trim();

  if (whole.startsWith("[")) {
    try {
      const arr = JSON.parse(whole);
      if (Array.isArray(arr)) entries.push(...arr);
    } catch {
      /* 落到逐行解析 */
    }
  }
  if (entries.length === 0) {
    for (const raw of whole.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
  }

  const out: LyricLine[] = [];
  for (const e of entries) {
    if (typeof e?.t !== "number") continue;
    const chunkText = (Array.isArray(e.c) ? e.c : [])
      .map((c) => (typeof c?.tx === "string" ? c.tx : ""))
      .join("")
      .trim();
    if (!chunkText) continue; // 间奏空行跳过
    if (CREDIT_RE.test(chunkText)) continue; // 署名行（作词/作曲…）不算歌词
    out.push({ time_ms: e.t, text: chunkText });
  }
  return out.sort((a, b) => a.time_ms - b.time_ms);
}

/** 标准 LRC 优先，其次网易云新 JSON 格式 */
function parseAnyLyric(text: string): LyricLine[] {
  const lrc = parseSyncedLrc(text);
  return lrc.length > 0 ? lrc : parseNeteaseJsonLyric(text);
}

async function postJson(url: string, body: string): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(url, { method: "POST", headers: HEADERS, body });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function search(title: string, artist: string): Promise<ProviderLyrics | null> {
  const query = `${title} ${artist}`.trim();
  const searchJson = await postJson(
    "https://music.163.com/api/search/get/web",
    `s=${encodeURIComponent(query)}&type=1&limit=20&offset=0`
  );
  const result = searchJson?.result as Record<string, unknown> | undefined;
  const songs = (result?.songs ?? []) as NeteaseSong[];
  if (songs.length === 0) return null;

  const candidates: Candidate[] = songs.map((s) => ({
    id: String(s.id ?? ""),
    title: s.name ?? "",
    artists: (s.artists ?? []).map((a) => a.name ?? ""),
    album: s.album?.name,
    durationMs: typeof s.duration === "number" ? s.duration : undefined,
  }));

  const best = pickBest(candidates, { title, artist, durationMs: undefined });
  if (!best?.id) return null;

  const lrcJson = await postJson(
    "https://interface3.music.163.com/api/song/lyric/v1",
    `id=${best.id}&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`
  );
  const lrcObj = lrcJson?.lrc as Record<string, unknown> | undefined;
  const text = typeof lrcObj?.lyric === "string" ? lrcObj.lyric : "";
  if (!text) return null;

  const lines = parseAnyLyric(text);
  if (lines.length === 0) return null;

  // 网易云搜索返回的 duration 是毫秒
  const duration = best.durationMs && best.durationMs > 0 ? Math.round(best.durationMs / 100) / 10 : null;
  return { lines, duration };
}

export async function fetchLyricsFromNetease(
  title: string,
  artist: string
): Promise<ProviderLyrics | null> {
  if (!title) return null;
  const raw = await search(title, artist);
  if (raw) return raw;

  // 清洗后（去掉 (Live)/feat. 等）再试一次 —— 与 eIsland 一致
  const cleanedTitle = cleanTitle(title);
  const cleanedArtist = cleanArtist(artist);
  if (cleanedTitle !== title || cleanedArtist !== artist) {
    return search(cleanedTitle, cleanedArtist);
  }
  return null;
}
