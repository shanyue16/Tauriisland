import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";
import { useCoverAccent } from "../hooks/useCoverAccent";
import { useScrub } from "../hooks/useScrub";
import { controlPlayback } from "../services/playbackControl";
import { isStageControlActive } from "../services/playbackSources/stage";

interface MusicPageProps {
  data: MusicData | null;
  /** 悬浮态不显示歌词（用户确认），仍保留该 prop 以保持调用方接口稳定 */
  lyrics: LyricLine[];
}

export default function MusicPage({ data }: MusicPageProps) {
  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  // 封面主色：与失焦态/展开态同一来源 —— 悬浮态的封面光晕与进度条都用它（同源）。
  // hook 必须放在下面的条件 return 之前（Hooks 规则）。
  const { accent, accent2 } = useCoverAccent(data?.cover_url ?? null);
  const coverGlow = `0 0 0 1px ${accent}40, 0 0 10px 2px ${accent}59, 0 1px 3px rgba(0,0,0,0.2)`;

  // 拖动跳转（seek）：与展开态共用同一个 hook（见 hooks/useScrub.ts）。
  // 同样必须在条件 return 之前 —— 提前 return 会跳过它后面的所有 hook。
  const duration = data && data.duration > 0 ? data.duration : 0;
  const scrub = useScrub({
    durationSec: duration,
    positionSec: data?.position ?? 0,
    tick: data?.timestamp ?? 0,
    enabled: isStageControlActive(),
  });

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

  const seekable = duration > 0 && isStageControlActive();
  const posSec = scrub.scrubSec ?? (data.position || 0);
  const progress = duration > 0 ? Math.min((posSec / duration) * 100, 100) : 0;
  const timeStr = formatTime(posSec);
  const totalStr = duration > 0 ? formatTime(duration) : "—:—";

  return (
    // 内边距口径与加载态/空态一致（垂直 py-1 = 线框稿 mini 规格 4px）；
    // 左侧 18px = 用户要求悬浮态内容别贴着窗口边缘（原 14px）；
    // 右侧留 26px：悬浮态竖排页码指示器在 right:8，右对齐的控件不能贴上去。
    //
    // 版式（用户指定）：[封面] [歌名 / 歌手] …… [控件靠右] 上排，[进度条][时间] 下排。
    // 控件放在**歌名歌手两行块的右侧**而不是自己占一行 —— 用户要求，也顺带把
    // 高度还给进度条：命中区(14px)与控件不在同一行，永远不会互相抢点击。
    <div
      className="w-full h-full flex flex-col justify-center gap-[4px] py-1 px-[18px] pr-[26px]"
      style={{ color }}
    >
      {/* 上排：封面 + 歌名/歌手 + 控件（靠右） */}
      <div className="flex items-center gap-2 min-w-0">
        {data.cover_url ? (
          <img
            src={data.cover_url}
            alt=""
            className="w-7 h-7 rounded-md object-cover flex-shrink-0"
            draggable={false}
            style={{ boxShadow: coverGlow }}
          />
        ) : (
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--surface-1)", boxShadow: coverGlow }}
          >
            <MusicIcon size={14} style={{ color, opacity: 0.5 }} />
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col gap-[1px] text-left">
          <div className="text-[12px] font-medium leading-tight truncate">
            {data.title || "未知曲目"}
          </div>
          <div
            className="text-[9.5px] leading-tight truncate"
            style={{ color: muted, opacity: 0.9 }}
          >
            {data.artist || "未知艺术家"}
          </div>
        </div>

        {/* 控件靠右。点击 stopPropagation：悬浮态整块可点（点了进展开态），
            不拦冒泡会让一次点击做两件事。只报语义动作，走 playbackControl 的路由。 */}
        <div className="flex items-center gap-[3px] shrink-0" style={{ marginLeft: "auto" }}>
          <CtrlButton tip="上一首" onClick={() => controlPlayback("prev")}>
            <PrevIcon size={12} />
          </CtrlButton>
          <CtrlButton
            tip={data.playing ? "暂停" : "播放"}
            width={22}
            onClick={() => controlPlayback("toggle")}
          >
            {data.playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
          </CtrlButton>
          <CtrlButton tip="下一首" onClick={() => controlPlayback("next")}>
            <NextIcon size={12} />
          </CtrlButton>
        </div>
      </div>

      {/* 下排：[进度条][时间]（用户指定同行，条在前、时间在后）。
          命中区 = 这一整行 14px（条本体 3px 居中）；轨道带一圈封面主色光晕
          （track 自身的 boxShadow 不受自己 overflow:hidden 影响，看得见），
          已播段用同色渐变，这样"封面光晕 = 进度条颜色"是同源。 */}
      <div className="flex items-center gap-2 min-w-0">
        <div
          ref={scrub.barRef}
          className={`flex-1 min-w-0 h-[14px] flex items-center${seekable ? " cursor-pointer" : ""}`}
          data-tip={seekable ? "点击或拖动可跳转" : undefined}
          style={{ touchAction: "none" }}
          {...scrub.handlers}
        >
          <div
            className="w-full h-[3px] rounded-full overflow-hidden flex-shrink-0"
            style={{
              backgroundColor: "var(--slider-track)",
              boxShadow: `0 0 6px 1px ${accent}40`,
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progress}%`,
                background: `linear-gradient(90deg, ${accent}, ${accent2})`,
                // 拖动中要跟手，不能有过渡（否则游标追不上指针）
                transition: scrub.scrubbing ? "none" : "width 0.3s linear",
              }}
            />
          </div>
        </div>
        <span
          className="text-[9px] tabular-nums shrink-0 leading-none"
          style={{ color: muted }}
        >
          {timeStr}/{totalStr}
        </span>
      </div>
    </div>
  );
}

/** 悬浮态的紧凑控制键：18×18（播放键宽 22），hover 用 `--sidebar-tab-hover` 面 */
function CtrlButton({
  tip,
  onClick,
  width = 18,
  children,
}: {
  tip: string;
  onClick: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      aria-label={tip}
      onClick={(e) => {
        e.stopPropagation();
        void onClick();
      }}
      className="flex items-center justify-center rounded-md opacity-90 hover:opacity-100 hover:bg-[var(--sidebar-tab-hover)]"
      style={{ width, height: 18, color: "var(--island-text)", background: "transparent", cursor: "pointer" }}
    >
      {children}
    </button>
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

function PrevIcon({ size = 13, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
    </svg>
  );
}

function NextIcon({ size = 13, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
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
