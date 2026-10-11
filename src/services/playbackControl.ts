/**
 * 播放控制的**路由层** —— 决定这一下点击发给谁。
 *
 * ## 为什么需要它
 * 项目原先的规矩是「控制始终走 SMTC」（见 `playbackSources/types.ts` §分工原则）。
 * 但 Folia 的 Stage API（32107）实测 `controlCapabilities` 全为 true，
 * 且它是**唯一能在酷狗这种「系统媒体接口不上报时间线」的播放器上真正控制到播放**的通道
 * —— 用户拍板开第二个通道，于是加这一层。
 *
 * ## 路由规则（任一条件不满足就还是走 SMTC）
 * 只有当 Stage **已启用 + token 有效 + 最近 2.5s 内核对通过**（即确认过
 * 「Stage 报的曲目就是我们正在放的这首」）时，才把控制发给 Stage。
 * 其余一切情况一律走原来的 SMTC —— 没装/没开/放的不是同一首时，行为与从前**完全一致**。
 *
 * ## 失败时回不退？
 * **只有「明确被拒」（4xx）才回退**。5xx / 超时的结果未知，
 * 此时再发一次 SMTC 可能造成双动作（pause 其实成功了、再 toggle 反而恢复播放），
 * 所以宁可这一下失败也不冒险。这条分界写在 `stage.ts` 的 `StageControlResult` 里。
 *
 * ## 动作映射
 * 语义层统一用 `toggle`（UI 只有「播放/暂停」一个键），路由到 Stage 时按它报的
 * `playerState` 决定发 `pause` 还是 `resume` —— 官方动作枚举里**没有 `play`**。
 */

import { controlMusic } from "./music";
import { isStageControlActive, sendStageControl, stagePlayerState } from "./playbackSources/stage";
import { recordControlStatus } from "./playbackSources/status";

/** 语义层动作。`toggle` = 「播放/暂停」那一个键，由路由层决定具体发什么。 */
export type PlaybackAction = "toggle" | "next" | "prev" | "seek";

const SMTC_ACTION: Record<Exclude<PlaybackAction, "seek">, "toggle" | "next" | "prev"> = {
  toggle: "toggle",
  next: "next",
  prev: "prev",
};

/**
 * 控制播放。返回是否**确定**成功（结果未知时返回 false）。
 *
 * - `toggle` / `next` / `prev`：优先 Stage，必要时（明确被拒）回退 SMTC
 * - `seek`：**只有 Stage 支持**（SMTC 侧没有 seek 命令），`positionSec` 是秒
 *
 * **永不抛异常。** 每次结果都记进 `status.ts`，设置页可看到「点的是哪条路」。
 */
export async function controlPlayback(
  action: PlaybackAction,
  positionSec?: number
): Promise<boolean> {
  const viaStage = isStageControlActive();

  if (viaStage) {
    // toggle 要按 Stage 自己报的状态翻转（更可靠：SMTC 在酷狗上可能报错播放态）
    const stageAction =
      action === "seek"
        ? "seek"
        : action === "toggle"
          ? stagePlayerState() === "PLAYING"
            ? "pause"
            : "resume"
          : action;

    const r = await sendStageControl(
      stageAction,
      action === "seek" ? Math.round((positionSec ?? 0) * 1000) : undefined
    );
    if (r.ok) {
      recordControlStatus({ action, viaStage: true, ok: true });
      return true;
    }
    if (!r.rejected) {
      // 结果未知 → 绝不回退，避免双动作
      recordControlStatus({ action, viaStage: true, ok: false, detail: r.detail });
      return false;
    }
    // 明确被拒 → 落到 SMTC（下面继续）
  }

  if (action === "seek") {
    // SMTC 侧没有 seek，只能如实报失败
    recordControlStatus({
      action,
      viaStage: false,
      ok: false,
      detail: "系统媒体接口不支持跳转，需要开启 Stage API",
    });
    return false;
  }

  const res = await controlMusic(SMTC_ACTION[action]);
  recordControlStatus({ action, viaStage: false, ok: res.ok, detail: res.error });
  return res.ok;
}
