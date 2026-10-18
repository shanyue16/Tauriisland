import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../stores/settings";

/**
 * 发送系统通知。
 *
 * ⚠️ 这里用 Rust 命令而不是 `@tauri-apps/plugin-notification`：通知的**读取**链路已经全在
 * Rust 侧（`notifications.rs` + 若干命令），发送也放同一侧可以少装一个前端插件依赖、
 * 少一份 capabilities 授权面。capabilities 里的 `notification:default` 是给插件自身
 * 注册用的（Rust 侧直接调用不走 IPC 权限）。
 *
 * 已知平台行为（实测插件源码，见 docs/notifications-plan.md §3.5）：
 * - desktop 上无需申请权限，`requestPermission()` 直接返回 granted、不弹系统提示
 *   → 不做权限引导 UI；
 * - 通知撤回在 Windows 上是空实现 → 不提供"撤回"能力；
 * - `npm run tauri dev` 时 exe 位于 `target\debug`，插件不会设置 AUMID，
 *   所以通知归属的应用身份可能显示不准（不影响能否弹出，安装版正常）。
 */

export interface NotifyOptions {
  title: string;
  body?: string;
  /**
   * 预留：同一 key 的通知在系统里互相替换，避免闹钟刷屏。
   * Windows 侧 notify-rust 不支持替换，当前**未生效**，仅作为将来跨平台/自定义实现的接口。
   */
  tag?: string;
  /**
   * 预留：将来点击通知要跳回岛的哪个页。
   * 当前系统通知的点击由 Windows 处理（`launch` 参数），尚未接回应用内路由。
   */
  route?: "music" | "calendar" | "notification";
}

/**
 * 发送一条系统通知。
 *
 * **永不抛异常**：失败只返回 `false`（与 fetchMusic / 日历接口同一降级口径），
 * 调用方不需要 try/catch。
 *
 * 开关 `systemNotification`（设置页 · 通知 · 发送通知）关掉时**直接返回 false、不调 Rust**：
 * 应用内的提醒卡片与提示音不受影响，只是不再进 Windows 通知中心。
 */
export async function sendNotification(opts: NotifyOptions): Promise<boolean> {
  if (!useSettings.getState().settings.systemNotification) return false;
  try {
    await invoke("send_notification", {
      title: opts.title,
      body: opts.body ?? null,
    });
    return true;
  } catch (err) {
    console.error("[notify] send_notification failed:", err);
    return false;
  }
}
