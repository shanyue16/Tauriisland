import { useEffect, useState, useCallback, useRef } from "react";
import { fetchMusic } from "../services/music";
import { fetchLyricsFromLrclib, type LyricsResult } from "../services/lyrics";
import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";

const POLL_INTERVAL = 500; // ms — 只负责刷新 SMTC 基准值
const TICK_INTERVAL = 66;  // ms — ~15Hz 平滑外推 (eIsland 同样 66ms)

const lyricsCache = new Map<string, LyricsResult>();
const itunesCoverCache = new Map<string, string>();

function makeTrackKey(title: string | null, artist: string | null): string {
  return `${title || ""}||${artist || ""}`;
}

/** iTunes 封面兜底 — track 稳定后调用，缓存 */
async function fetchItunesCover(title: string, artist: string): Promise<string | null> {
  const key = makeTrackKey(title, artist);
  const cached = itunesCoverCache.get(key);
  if (cached !== undefined) return cached || null;

  try {
    const query = `${title} ${artist}`.trim();
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`
    );
    if (resp.ok) {
      const data = (await resp.json()) as { results?: { artworkUrl100?: string }[] };
      const url = data?.results?.[0]?.artworkUrl100;
      if (url) {
        const big = url.replace("100x100bb", "600x600bb");
        itunesCoverCache.set(key, big);
        return big;
      }
    }
  } catch { /* 忽略 */ }
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
      const nowTs = Date.now();

      const rawPos = m.position || 0;
      const rawDur = m.duration || 0;
      const playing = m.playing;
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

        // 清掉待定 iTunes 兜底
        if (itunesTimerRef.current !== null) {
          clearTimeout(itunesTimerRef.current);
          itunesTimerRef.current = null;
        }

        // 异步加载歌词（同时拿到 LRCLIB duration）
        void loadLyrics(m.title || "", m.artist || "");
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
      // 1) LRCLIB duration (已加载的精确值)
      // 2) SMTC rawDur (合理区间 + 与 LRCLIB 冲突时信 LRCLIB)
      // 3) 歌词末行 time_ms/1000 + 5s
      // 4) sameTrack 上次值 (Rust 侧 rawDur 已经 sameTrack 兜底过)
      let effectiveDur = 0;
      const lrclibDur = lrclibDurationRef.current;

      if (lrclibDur > 0) {
        effectiveDur = lrclibDur;
        // SMTC 合理区间 (5s ~ 3600s) 且偏差 < 5s 时采信 LRCLIB (规格: LRCLIB 优先)
        if (rawDur > 5 && rawDur < 3600 && Math.abs(rawDur - lrclibDur) < 5) {
          effectiveDur = lrclibDur; // 冲突时仍信 LRCLIB
        }
      } else if (rawDur > 5 && rawDur < 3600) {
        effectiveDur = rawDur;
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
        cover_url: m.cover_url ?? null,
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

  /** 异步加载歌词 + LRCLIB duration */
  async function loadLyrics(title: string, artist: string) {
    const key = makeTrackKey(title, artist);
    const cached = lyricsCache.get(key);
    if (cached) {
      lyricsRef.current = cached.lines;
      setLyrics(cached.lines);
      if (cached.duration && cached.duration > 0) {
        lrclibDurationRef.current = cached.duration;
        effectiveDurRef.current = cached.duration;
      }
      return;
    }
    try {
      const result = await fetchLyricsFromLrclib(title, artist);
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
