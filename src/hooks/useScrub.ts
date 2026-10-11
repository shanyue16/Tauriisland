import { useEffect, useRef, useState } from "react";
import { controlPlayback } from "../services/playbackControl";

/**
 * 进度条「点/拖跳转（seek）」的共用逻辑 —— 展开态与悬浮态都用它。
 *
 * 这段逻辑很微妙，抄两份迟早只修一处，所以抽成一个 hook。四件事必须同时成立：
 *
 * 1. **拖动中只做本地预览，松手才发请求** —— 否则每移一像素就打一次
 *    `POST /stage/player/control`。
 * 2. **跳完要由本地接管显示，直到真实位置跟上** —— 主轮询 500ms 一次，
 *    若松手后立刻把显示权交还给真实位置，条会先弹回原处再跳到目标，看起来像没生效。
 * 3. **接管有绝对截止时间** —— 兜底 seek 失败时不会永久显示一个假位置；
 *    定时器按绝对时间算，所以每一拍重新布置也不会把它越推越晚。
 * 4. **拖动过程中不能被外部状态拽走** —— 真实位置每 500ms 更新一次，拖动期间必须忽略。
 *
 * 调用方负责把 `barRef` 挂到进度条（或它的加宽命中区）上，并展开 `handlers`。
 * 命中区的加宽（`padding` + 等量负 `margin`）由调用方决定 —— 展开态上下各 6px
 * 都安全；悬浮态**只能在下方加**，因为它的控件行紧贴条上方。
 */
export interface ScrubApi {
  /** 挂到进度条（或它的命中区）上，用于把 clientX 换算成比例 */
  barRef: React.RefObject<HTMLDivElement | null>;
  /** 本地覆盖的秒数（正在拖 / 刚跳完还没跟上）；`null` = 用真实位置 */
  scrubSec: number | null;
  /** 是否正处于"本地接管"状态（拖动中或刚跳完）—— 用来关掉 transition 让条跟手 */
  scrubbing: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: () => void;
  };
}

export function useScrub(opts: {
  /** 曲长（秒）；<= 0 表示没有真实时长，整条链路不启用 */
  durationSec: number;
  /** 真实播放位置（秒），用于判断真实值有没有追上本地接管值 */
  positionSec: number;
  /** 每一拍都会变的量（`MusicData.timestamp`）：暂停时位置不变，靠它保证释放检查仍在跑 */
  tick: number;
  /** 调用方的启用条件（本项目的现状：只有 Stage 可用时才开） */
  enabled: boolean;
  /** 本地接管的最长时间（ms） */
  holdMs?: number;
}): ScrubApi {
  const { durationSec, positionSec, tick, enabled, holdMs = 2500 } = opts;
  const canScrub = enabled && durationSec > 0;

  const barRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const scrubDeadlineRef = useRef(0);

  /** clientX → 秒（按条的实际像素宽度折算，越界夹紧） */
  const secFromPointer = (clientX: number): number => {
    const el = barRef.current;
    if (!el || durationSec <= 0) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const ratio = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return ratio * durationSec;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canScrub) return;
    // 悬浮态（medium）在鼠标移出时会自动收起，而拖动进度条时指针很容易短暂移出岛体
    // —— 那会中途把岛收回 minimal、拖动直接断掉。拖动期间挂一个 hold，
    // Island 的 onMouseLeave 见到 hold 就不安排收起。
    if (!draggingRef.current) pointerHolds += 1;
    draggingRef.current = true;
    // 捕获指针：拖到岛外（甚至窗口外）也还能收到 move，松手不会丢
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubSec(secFromPointer(e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setScrubSec(secFromPointer(e.clientX));
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const target = secFromPointer(e.clientX);
    // 顺序要紧：先写好截止时间，再放开 dragging，
    // 否则下面的释放 effect 会在同一帧里立刻把 scrubSec 清掉。
    scrubDeadlineRef.current = Date.now() + holdMs;
    draggingRef.current = false;
    releasePointerHold();
    setScrubSec(target);
    await controlPlayback("seek", target);
  };

  const onPointerCancel = () => {
    if (draggingRef.current) releasePointerHold();
    draggingRef.current = false;
    setScrubSec(null);
  };

  // 真实位置追上（或超时）后把显示权交还给真实位置。
  // 依赖 tick 而不只是 position：暂停时位置不变，靠 tick 才能保证每一拍都来检查一次。
  useEffect(() => {
    if (scrubSec === null || draggingRef.current) return;
    if (Math.abs(positionSec - scrubSec) < SKIP_TOLERANCE_SEC) {
      setScrubSec(null);
      return;
    }
    const remain = Math.max(0, scrubDeadlineRef.current - Date.now());
    const t = window.setTimeout(() => setScrubSec(null), remain);
    return () => window.clearTimeout(t);
  }, [tick, positionSec, scrubSec]);

  return {
    barRef,
    scrubSec,
    scrubbing: scrubSec !== null,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}

/** 真实位置与本地接管值相差小于这个数就算"跟上了"，可以交还显示权（秒） */
const SKIP_TOLERANCE_SEC = 2.5;

// —— 拖动期间的「别收起」信号 ——
// 悬浮态在鼠标移出时会自动收起（Island.handleMouseLeave），而拖动进度条时指针
// 很容易短暂移出岛体。没有这个 hold 的话，拖动会在半路被收起打断。
// 用计数而不是布尔：理论上可能有两个条同时被拖（目前没有，但计数不会因此出错）。
let pointerHolds = 0;

function releasePointerHold(): void {
  pointerHolds = Math.max(0, pointerHolds - 1);
}

/** 现在是否正在拖动某条进度条（Island 的 onMouseLeave 用它决定要不要安排收起） */
export function isPointerHeld(): boolean {
  return pointerHolds > 0;
}
