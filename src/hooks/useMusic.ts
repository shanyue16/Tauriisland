import { useEffect, useState, useCallback, useRef } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { fetchMusic } from "../services/music";
import { useSettings } from "../stores/settings";
import { fetchLyricsMulti, type LyricsResult } from "../services/lyrics";
import { kugouLookup, type KugouTrack } from "../services/kugou";
import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";

const POLL_INTERVAL = 500; // ms — 只负责刷新 SMTC 基准值
const TICK_INTERVAL = 66;  // ms — ~15Hz 平滑外推 (eIsland 同样 66ms)

const lyricsCache = new Map<string, LyricsResult>();
const itunesCoverCache = new Map<string, string>();
/** 酷狗专辑封面缓存（按 track key）——换回同一首时必须能从这里恢复 */
const kugouCoverCache = new Map<string, string>();

function makeTrackKey(title: string | null, artist: string | null): string {
  return `${title || ""}||${artist || ""}`;
}

/**
 * iTunes 封面兜底 — track 稳定后调用，缓存。
 * 必须用 Tauri HTTP 插件（白名单已放行 itunes.apple.com）；全局 fetch 会被
 * WebView 的 CORS 拦掉导致兜底静默失效。先按「曲名+歌手」查，失败再用纯曲名。
 */
async function fetchItunesCover(title: string, artist: string): Promise<string | null> {
  const key = makeTrackKey(title, artist);
  const cached = itunesCoverCache.get(key);
  if (cached !== undefined) return cached || null;

  const cleanTitle = title.replace(/\s*[([（【][^)）】]*[)）】]\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  const queries = [`${title} ${artist}`.trim(), cleanTitle, cleanTitle.split(/\s+/)[0] || title]
    .filter((q, i, arr) => q && arr.indexOf(q) === i);

  for (const query of queries) {
    try {
      const resp = await tauriFetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as { results?: { artworkUrl100?: string }[] };
      const url = data?.results?.[0]?.artworkUrl100;
      if (url) {
        const big = url.replace("100x100bb", "600x600bb");
        itunesCoverCache.set(key, big);
        return big;
      }
    } catch { /* 尝试下一个查询 */ }
  }

  itunesCoverCache.set(key, ""); // 缓存空结果避免重复请求
  return null;
}

export function useMusic() {
  const [data, setData] = useState<MusicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);

  // refs (跨 render 持久化)
  const prevTrackKeyRef = useRef<string>("");
  const lyricsRef = useRef<LyricLine[]>([]);
  const lrclibDurationRef = useRef<number>(0);
  /** 酷狗专辑封面（SMTC 无封面时用） */
  const kugouCoverRef = useRef<string | null>(null);

  // position 外推基准
  const progressBaseRef = useRef<number>(0);       // 最新 rawPos 或 seek 重置后的位置
  const progressBaseTsRef = useRef<number>(0);     // progressBase 对应的服务器时间戳 (Date.now())

  // SMTC 元数据缓存
  const lastLutRef = useRef<number | null>(null);
  const lastRawPosRef = useRef<number>(0);
  const lastTrackStablePollsRef = useRef<number>(0); // 同一 track 连续 poll 次数

  // 66ms tick
  const tickTimerRef = useRef<number | null>(null);
  const playingRef = useRef<boolean>(false);
  const effectiveDurRef = useRef<number>(0);
  const effectivePosRef = useRef<number>(0); // 当前 tick 计算出的 position

  // iTunes 封面兜底定时器
  const itunesTimerRef = useRef<number | null>(null);

  /** 启动 / 停止 66ms tick */
  const ensureTick = useCallback(() => {
    if (tickTimerRef.current !== null) return;
    tickTimerRef.current = window.setInterval(() => {
      if (!playingRef.current) return;
      const now = Date.now();
      const dur = effectiveDurRef.current;
      let pos: number;

      if (lastLutRef.current !== null && lastLutRef.current > 1_000_000_000_000) {
        // LUT 有效 → 按 LUT 外推（PotPlayer / 稀疏更新场景）
        const elapsedSec = (now - lastLutRef.current) / 1000;
        pos = progressBaseRef.current + elapsedSec;
      } else {
        // LUT 无效 → 按 poll 时间基准外推（酷狗 / 无 timeline 场景）
        const deltaSec = (now - progressBaseTsRef.current) / 1000;
        pos = progressBaseRef.current + deltaSec;
      }

      if (dur > 0 && pos > dur) pos = dur;
      if (pos < 0) pos = 0;

      effectivePosRef.current = pos;

      // 只更新 position/duration — 其他字段用 poll 的值
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          position: Math.round(pos * 10) / 10,
          duration: Math.round(dur * 10) / 10,
        };
      });
    }, TICK_INTERVAL);
  }, []);

  const stopTick = useCallback(() => {
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  /** 主 poll 函数 — 500ms 一次，只刷新基准值 */
  const poll = useCallback(async () => {
    try {
      const m = await fetchMusic();

      // —— 播放器白名单过滤 ——
      // 非空时只接受白名单内的会话（忽略大小写、子串匹配，与 eIsland 一致）；
      // 用 getState 读取，避免把白名单加进 useCallback 依赖而重建轮询定时器。
      const whitelist = useSettings.getState().settings.musicWhitelist ?? [];
      const appName = (m.app_name ?? "").trim().toLowerCase();
      // app_name 为空 ＝ 播放器没有上报自身标识（来源未知）：按「放行」处理——
      // 宁可多显示一个未知来源，也不要有歌正在放却什么都看不到。
      const blockedByWhitelist =
        whitelist.length > 0 &&
        m.active &&
        appName.length > 0 &&
        !whitelist.some((entry) => {
          const e = entry.trim().toLowerCase();
          return e.length > 0 && appName.includes(e);
        });

      if (blockedByWhitelist) {
        // 白名单外的播放器：本拍视为"无歌曲"（只重置与曲目相关的引用与本地时钟）
        if (prevTrackKeyRef.current) {
          prevTrackKeyRef.current = "";
          lyricsRef.current = [];
          setLyrics([]);
          kugouCoverRef.current = null;
        }
        stopTick();
        setData({
          ...m,
          active: false,
          title: null,
          artist: null,
          album: null,
          cover_url: null,
          playing: false,
          position: 0,
          duration: 0,
        });
        return;
      }

      const nowTs = Date.now();

      const rawPos = m.position || 0;
      const rawDur = m.duration || 0;
      // 时间线完全缺失的播放器（酷狗）：SMTC 没有 position/duration，
      // 且其 PlaybackStatus 可能报非播放态，这里按"有会话即视为在播"驱动本地时钟，
      // 否则进度条会永久停在 0。
      const hasTimeline = (rawDur > 5 && rawDur < 3600) || rawPos > 0;
      const playing = m.playing || (m.active && !hasTimeline);
      const lut = m.timeline_lut ?? null;

      // —— 换歌检测 ——
      const currentKey = makeTrackKey(m.title, m.artist);
      const hasTrack = m.active && m.title;
      const trackChanged = hasTrack && currentKey !== prevTrackKeyRef.current;

      if (trackChanged) {
        prevTrackKeyRef.current = currentKey;
        lastTrackStablePollsRef.current = 0;
        lrclibDurationRef.current = 0;
        progressBaseRef.current = 0;
        progressBaseTsRef.current = nowTs;
        lastLutRef.current = null;
        lastRawPosRef.current = 0;
        effectiveDurRef.current = 0;
        effectivePosRef.current = 0;
        lyricsRef.current = [];
        setLyrics([]);
        kugouCoverRef.current = null;

        // 清掉待定 iTunes 兜底
        if (itunesTimerRef.current !== null) {
          clearTimeout(itunesTimerRef.current);
          itunesTimerRef.current = null;
        }

        // 异步加载曲目元数据（酷狗优先：歌词 + 精确时长 + 封面）
        void loadTrackMeta(m.title || "", m.artist || "", m.app_name ?? null);
      } else if (!hasTrack && prevTrackKeyRef.current) {
        // 播放器退出
        prevTrackKeyRef.current = "";
        lyricsRef.current = [];
        setLyrics([]);
        effectiveDurRef.current = 0;
        effectivePosRef.current = 0;
        stopTick();
        playingRef.current = false;
      } else if (hasTrack) {
        // 同一首歌连续 poll → 计数 + 1，稳定 N 次后才尝试 iTunes 兜底
        lastTrackStablePollsRef.current += 1;
      }

      // —— Duration 优先级链 ——
      // 1) SMTC 有合理值就用它：这是"播放器自己上报"的时长，与播放器界面显示天然一致
      //    （网易云/ PotPlayer 走这条；酷狗不上报时间线，所以落到 2）
      // 2) SMTC 没有(0/超范围) → 用外部元数据源的精确时长（酷狗搜索接口 / LRCLIB）
      // 3) 都没有 → 歌词末行 + 5s 尾奏
      let effectiveDur = 0;
      const lrclibDur = lrclibDurationRef.current;
      const smtcPlausible = rawDur > 5 && rawDur < 3600;

      if (smtcPlausible) {
        effectiveDur = rawDur;
      } else if (lrclibDur > 0) {
        effectiveDur = lrclibDur;
      } else if (lyricsRef.current.length > 0) {
        effectiveDur = lyricsRef.current[lyricsRef.current.length - 1].time_ms / 1000 + 5;
      }
      effectiveDurRef.current = effectiveDur;

      // —— Seek 检测 (阈值 0.5s, eIsland 同款) ——
      let seeked = false;
      if (rawPos > 0 && lastRawPosRef.current > 0 && Math.abs(rawPos - lastRawPosRef.current) > 0.5) {
        seeked = true;
      }
      if (lastLutRef.current !== null && lut !== null) {
        const lutDelta = Math.abs(lut - lastLutRef.current);
        if (lutDelta > 200 && rawPos > 0 && lastRawPosRef.current > 0) {
          seeked = true;
        }
      }

      // —— 暂停 / 播放切换 ——
      if (playing !== playingRef.current) {
        playingRef.current = playing;
        if (playing) {
          // 恢复播放 → 重新对齐基准
          progressBaseRef.current = rawPos;
          progressBaseTsRef.current = nowTs;
          ensureTick();
        } else {
          // 暂停 → 冻结 tick，冻结当前位置
          stopTick();
          progressBaseRef.current = effectivePosRef.current || rawPos;
          progressBaseTsRef.current = nowTs;
        }
      }

      // —— seek 时重置基准 ——
      if (seeked && rawPos > 0) {
        progressBaseRef.current = rawPos;
        progressBaseTsRef.current = nowTs;
        effectivePosRef.current = rawPos;
      } else if (rawPos > 0) {
        // 正常刷新基准（不打断外推平滑性，只是更新锚点）
        progressBaseRef.current = rawPos;
        progressBaseTsRef.current = nowTs;
      }

      lastLutRef.current = lut;
      lastRawPosRef.current = rawPos;

      if (playing) ensureTick();

      // —— iTunes 封面兜底 ——
      // cover_url 空 + track 稳定 N 次后再请求（debounce 避免换歌时 spam）
      if (
        hasTrack &&
        !m.cover_url &&
        !kugouCoverRef.current &&
        lastTrackStablePollsRef.current === 3 &&
        !itunesCoverCache.has(currentKey)
      ) {
        // track 稳定 3×500ms = 1.5s 后尝试 iTunes
        if (itunesTimerRef.current !== null) clearTimeout(itunesTimerRef.current);
        itunesTimerRef.current = window.setTimeout(async () => {
          const cover = await fetchItunesCover(m.title || "", m.artist || "");
          if (cover && prevTrackKeyRef.current === currentKey) {
            setData((prev) => prev ? { ...prev, cover_url: cover } : prev);
          }
        }, 300);
      }

      // —— 构建最终数据（position/duration 用 tick 实时值，其余用 poll 值）——
      const tickPos = effectivePosRef.current > 0
        ? effectivePosRef.current
        : (playing ? rawPos : rawPos);

      const finalData: MusicData = {
        ...m,
        cover_url: m.cover_url || kugouCoverRef.current || itunesCoverCache.get(currentKey) || null,
        position: Math.round(tickPos * 10) / 10,
        duration: Math.round(effectiveDur * 10) / 10,
      };

      setData(finalData);
    } catch (err) {
      console.warn("[useMusic] poll error:", err);
      playingRef.current = false;
      stopTick();
      setData({
        active: false, app_name: null, title: null, artist: null, album: null,
        cover_url: null, cover_status: null, playing: false,
        position: 0, duration: 0, timeline_lut: null, timestamp: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  }, [ensureTick, stopTick]);

  /**
   * 异步加载曲目元数据：歌词 + 精确时长 + 封面。
   *
   * ① 酷狗曲库查询：给精确时长与专辑封面（中文曲库命中率高，且给的是播放器自己那首）；
   * ② 歌词：eIsland 式多源级联 —— 来源播放器自己的源优先，其余源依次回退，LRCLIB 收尾兜底。
   */
  async function loadTrackMeta(title: string, artist: string, appName: string | null) {
    const key = makeTrackKey(title, artist);
    const cached = lyricsCache.get(key);
    if (cached) {
      lyricsRef.current = cached.lines;
      setLyrics(cached.lines);
      if (cached.duration && cached.duration > 0) {
        lrclibDurationRef.current = cached.duration;
        effectiveDurRef.current = cached.duration;
      }
      // 歌词命中缓存时同样要恢复封面 —— 换歌时 kugouCoverRef 被清空，
      // 否则"切走再切回同一首"会丢失封面。
      const cachedCover = kugouCoverCache.get(key);
      if (cachedCover) kugouCoverRef.current = cachedCover;
      return;
    }

    // 1) 酷狗曲库：精确时长 + 专辑封面
    let kugouTrack: KugouTrack | null = null;
    try {
      kugouTrack = await kugouLookup(title, artist);
      if (kugouTrack) {
        if (kugouTrack.duration > 0) {
          lrclibDurationRef.current = kugouTrack.duration;
          effectiveDurRef.current = kugouTrack.duration;
        }
        if (kugouTrack.cover) {
          kugouCoverRef.current = kugouTrack.cover;
          kugouCoverCache.set(key, kugouTrack.cover);
        }
      }
    } catch { /* 曲库查不到不影响下面的歌词级联 */ }

    // 2) 歌词：多源级联（网易云 / QQ / 酷狗 + LRCLIB 兜底）
    try {
      const result: LyricsResult | null = await fetchLyricsMulti({
        title,
        artist,
        appName,
        kugouTrack,
      });
      if (result && result.lines.length > 0) {
        lyricsCache.set(key, result);
        lyricsRef.current = result.lines;
        setLyrics(result.lines);
        if (result.duration && result.duration > 0) {
          lrclibDurationRef.current = result.duration;
          effectiveDurRef.current = result.duration;
        }
      } else {
        lyricsRef.current = [];
        setLyrics([]);
      }
    } catch {
      lyricsRef.current = [];
      setLyrics([]);
    }
  }

  useEffect(() => {
    setLoading(true);
    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL);
    return () => {
      clearInterval(interval);
      stopTick();
      if (itunesTimerRef.current !== null) clearTimeout(itunesTimerRef.current);
    };
  }, [poll, stopTick]);

  return { data, loading, lyrics };
}
