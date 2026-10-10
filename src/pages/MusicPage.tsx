import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";

interface MusicPageProps {
  data: MusicData | null;
  /** 悬浮态不再显示歌词（用户确认），仍保留该 prop 以保持调用方接口稳定 */
  lyrics: LyricLine[];
}

export default function MusicPage({ data }: MusicPageProps) {
  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  // 加载态 / 空态 / 正常态的内边距口径必须一致（垂直 py-1 = 线框稿 mini 规格 4px）：
  // 原来这两种非正常态只有 pt-1（上 4px、下 0），内容被推低 2px，从"加载中"切到
  // 正常内容、或切到另外两个页时会看到 2px 跳动。右侧 pr-[26px] 是给竖排页码指示器
  // （right:8）的专用通道。
  if (!data) {
    return (
      <div
        className="w-full h-full flex items-center justify-center py-1 px-[18px] pr-[26px]"
        style={{ color }}
      >
        <div className="text-[11px] opacity-60">加载中...</div>
      </div>
    );
  }

  if (!data.active) {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center py-1 gap-0.5 px-[18px] pr-[26px]"
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

  return (
    // 内边距口径与加载态/空态一致（垂直 py-1 = 线框稿 mini 规格 4px）；
    // 左侧 18px = 用户要求悬浮态内容别贴着窗口边缘（原 14px）；
    // 右侧留 26px：悬浮态竖排页码指示器在 right:8，进度时间（右对齐）不能贴上去。
    <div
      className="w-full h-full flex items-center gap-2 py-1 px-[18px] pr-[26px]"
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
          style={{ background: "var(--surface-1)", opacity: 0.5 }}
        >
          <MusicIcon size={14} style={{ color }} />
        </div>
      )}

      {/* 信息区：三行 —— 歌名+时间 / 歌手 / 进度条
          （悬浮态不放歌词：歌词只在展开态与失焦态出现，用户已确认） */}
      <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
        {/* 第一行: 歌名 + 时间 */}
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

        {/* 第二行: 歌手 */}
        <div
          className="text-[9.5px] leading-tight truncate max-w-full"
          style={{ color: muted, opacity: 0.9 }}
        >
          {data.artist || "未知艺术家"}
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
