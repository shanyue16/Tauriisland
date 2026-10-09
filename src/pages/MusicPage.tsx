import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";
import { getCurrentLyric } from "../services/lyrics";

interface MusicPageProps {
  data: MusicData | null;
  lyrics: LyricLine[];
}

export default function MusicPage({ data, lyrics }: MusicPageProps) {
  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  if (!data) {
    return (
      <div
        className="w-full h-full flex items-center justify-center pt-1 px-[14px]"
        style={{ color }}
      >
        <div className="text-[11px] opacity-60">加载中...</div>
      </div>
    );
  }

  if (!data.active) {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center pt-1 gap-0.5 px-[14px]"
        style={{ color }}
      >
        <MusicIcon size={18} style={{ color, opacity: 0.35 }} />
        <div className="text-[10px] opacity-40 leading-tight text-center truncate max-w-full">
          {data.diag ? `⚠ ${data.diag}` : "无活跃音乐"}
        </div>
      </div>
    );
  }

  const duration = data.duration > 0 ? data.duration : 0;
  const progress = duration > 0 ? Math.min((data.position / duration) * 100, 100) : 0;
  const timeStr = formatTime(data.position);
  const totalStr = duration > 0 ? formatTime(duration) : "—:—";

  const positionMs = (data.position || 0) * 1000;
  const currentLyric = getCurrentLyric(lyrics, positionMs);

  return (
    <div
      className="w-full h-full flex items-center gap-2 pt-1 pb-1 px-[14px]"
      style={{ color }}
    >
      {/* 封面缩略图 */}
      {data.cover_url ? (
        <img
          src={data.cover_url}
          alt=""
          className="w-7 h-7 rounded-md object-cover flex-shrink-0"
          draggable={false}
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}
        />
      ) : (
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(255,255,255,0.06)", opacity: 0.5 }}
        >
          <MusicIcon size={14} style={{ color }} />
        </div>
      )}

      {/* 信息区 */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {/* 第一行: 标题 + 时间 */}
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="text-[12px] font-medium leading-tight truncate flex-1 min-w-0">
            {data.title || "未知曲目"}
          </div>
          <div
            className="text-[9px] opacity-50 tabular-nums leading-none flex-shrink-0"
            style={{ color: muted }}
          >
            {timeStr}/{totalStr}
          </div>
        </div>

        {/* 第二行: 歌词 / 艺术家 */}
        <div className="text-[10px] leading-tight truncate max-w-full opacity-75">
          {currentLyric
            ? currentLyric.text
            : data.artist || (data.playing ? "♪ 正在播放" : "⏸ 已暂停")}
        </div>

        {/* 第三行: 进度条 */}
        <div
          className="w-full h-[3px] rounded-full overflow-hidden flex-shrink-0"
          style={{ backgroundColor: "var(--slider-track)" }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${progress}%`,
              backgroundColor: color,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!seconds || seconds <= 0) return "0:00";
  // 与播放器一致：对秒数截断（floor）
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function PlayIcon({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function MusicIcon({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}
