/**
 * 提示音 / 闹钟音。
 *
 * 素材在 `public/sounds/`（由 Vite 以 `/sounds/xxx` 提供，打包时随资产内嵌，不需要 fs 权限）。
 * 原文件是中文名 + 括号/空格，WebView2 上 URL 编码不稳，统一改成 ASCII：
 *
 * | 原文件 | 现文件 | 类型 |
 * |---|---|---|
 * | 简短提示音.wav | prompt-short.wav | 通知 |
 * | 短信(嗖).mp3 | prompt-sms-sou.mp3 | 通知 |
 * | 原版短信声.mp3 | prompt-sms-original.mp3 | 通知 |
 * | 水滴-短信提示音.mp3 | prompt-waterdrop.mp3 | 通知 |
 * | alarm-clock-ringing.mp3 | clock-ringing.mp3 | 闹钟 |
 * | alarm-clock.mp3 | clock-alarm.mp3 | 闹钟 |
 * | alarm-clock-electronic.mp3 | clock-electronic.mp3 | 闹钟 |
 * | alarm-clock-electronic-wrist-watch.mp3 | clock-watch.mp3 | 闹钟 |
 *
 * 选择存在设置里：`notificationSound` / `alarmSound`，取值是下面的 id、`"custom"`（用
 * `notificationSoundCustom` / `alarmSoundCustom` 里的 data URL）或 `"none"`。
 * 自定义音频直接以 data URL 落进 settings.json —— 不走 Rust 落盘、不需要 fs 权限，
 * 代价是 base64 体积（上传上限 400KB，见 MAX_CUSTOM_BYTES），够放 30s 的提示音。
 *
 * 生命周期（用户口径）：闹钟最长响 30 秒自动停；点岛 / Alt+C / 失焦立即停。
 */

import { useSettings } from "../stores/settings";
import { useCustomSounds } from "../stores/customSounds";
import type { CustomSound } from "../types";

export type SoundKind = "notification" | "alarm";

/** 生成一个自定义音效 id（调用方负责写回 settings.customSounds） */
export function newCustomSoundId(): string {
  return `custom:${Math.random().toString(36).slice(2, 10)}`;
}

export interface SoundOption {
  id: string;
  file: string;
}

export const NOTIFICATION_SOUNDS: SoundOption[] = [
  { id: "prompt-short", file: "/sounds/prompt-short.wav" },
  { id: "prompt-sms-sou", file: "/sounds/prompt-sms-sou.mp3" },
  { id: "prompt-sms-original", file: "/sounds/prompt-sms-original.mp3" },
  { id: "prompt-waterdrop", file: "/sounds/prompt-waterdrop.mp3" },
];

export const ALARM_SOUNDS: SoundOption[] = [
  { id: "clock-ringing", file: "/sounds/clock-ringing.mp3" },
  { id: "clock-alarm", file: "/sounds/clock-alarm.mp3" },
  { id: "clock-electronic", file: "/sounds/clock-electronic.mp3" },
  { id: "clock-watch", file: "/sounds/clock-watch.mp3" },
];

export const DEFAULT_NOTIFICATION_SOUND = NOTIFICATION_SOUNDS[0].id;
export const DEFAULT_ALARM_SOUND = ALARM_SOUNDS[0].id;

/** 自定义音频上传上限（原始文件字节数）—— 再大就把 settings.json 撑爆了 */
export const MAX_CUSTOM_BYTES = 400 * 1024;

const MAX_RING_MS = 30_000;
const ALARM_VOLUME = 0.85;
const PROMPT_VOLUME = 0.7;

/** 同一 src 复用同一个元素：避免每次响都新建 Audio（会闪一下解码延迟） */
const pool = new Map<string, HTMLAudioElement>();
let stopTimer: number | null = null;

function pickSource(kind: SoundKind, choice: string, customSounds: CustomSound[]): string | null {
  const list = kind === "notification" ? NOTIFICATION_SOUNDS : ALARM_SOUNDS;
  const fallback = list[0].file;
  if (choice === "none") return null;
  // 自定义音效库：按 id 取（kind 只用于下拉列表分组，不限制播放）
  const custom = customSounds.find((s) => s.id === choice);
  if (custom) return custom.data;
  // 旧版 "custom" 选择：取音效库中同类的第一条
  if (choice === "custom") {
    const legacy = customSounds.find((s) => s.kind === kind);
    return legacy ? legacy.data : fallback;
  }
  // 未知 id（条目已被删除 / 手工改坏）退回默认音，别让用户以为"设置了却永远不响"
  return list.find((o) => o.id === choice)?.file ?? fallback;
}

function element(src: string, loop: boolean, volume: number): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof window.Audio !== "function") return null;
  const cached = pool.get(src);
  if (cached) {
    cached.loop = loop;
    cached.volume = volume;
    return cached;
  }
  try {
    const el = new window.Audio(src);
    el.loop = loop;
    el.volume = volume;
    el.preload = "auto";
    pool.set(src, el);
    return el;
  } catch (err) {
    console.error("[audio] create element failed:", src, err);
    return null;
  }
}

/** 当前设置里的通知音源（找不到/未设置 → null，即静音） */
function notificationSrc(): string | null {
  const s = useSettings.getState().settings;
  // 自定义音效的音频本体在 sounds.json，不在 settings 里（见 src/stores/customSounds.ts）
  return pickSource("notification", s.notificationSound, useCustomSounds.getState().sounds);
}

function alarmSrc(): string | null {
  const s = useSettings.getState().settings;
  return pickSource("alarm", s.alarmSound, useCustomSounds.getState().sounds);
}

/**
 * 播一声提示音（不循环）。**永不抛异常**：自动播放被拦时只记日志，
 * 系统通知那条路仍然有效。
 */
export function playPromptSound(): void {
  const src = notificationSrc();
  if (!src) return;
  const el = element(src, false, PROMPT_VOLUME);
  if (!el) return;
  try {
    el.currentTime = 0;
    void el.play().catch((err) => console.error("[audio] prompt play failed:", err));
  } catch (err) {
    console.error("[audio] prompt play threw:", err);
  }
}

/** 开始响铃：循环播到 `durationMs`（默认 30s）或被 `stopAlarm()` 打断。 */
export function startAlarm(durationMs = MAX_RING_MS): void {
  stopAlarm();
  const src = alarmSrc();
  if (!src) return;
  const el = element(src, true, ALARM_VOLUME);
  if (!el) return;
  try {
    el.currentTime = 0;
    void el.play().catch((err) => console.error("[audio] alarm play failed:", err));
    stopTimer = window.setTimeout(() => stopAlarm(), durationMs);
  } catch (err) {
    console.error("[audio] startAlarm failed:", err);
    stopAlarm();
  }
}

/** 立即停止（幂等）；不动 location，避免下次从中间开始 */
export function stopAlarm(): void {
  if (stopTimer !== null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  for (const el of pool.values()) {
    if (!el.loop || el.paused) continue;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      /* 还没加载完 */
    }
  }
}

/**
 * 设置页的试听：播放**当前选择**的音效，返回是否需要停止。
 * 提醒音只响一遍；闹钟音试听到 4 秒自动停（真响铃是 30 秒，试听没必要那么久）。
 */
export function previewSound(kind: SoundKind): void {
  if (kind === "notification") {
    playPromptSound();
    return;
  }
  startAlarm(4_000);
}

/**
 * 试听**任意一段**音频源（自定义音效列表里逐条试听用）。
 * 不抛异常：解码失败只记日志。
 */
export function previewSoundSrc(src: string): void {
  if (!src.startsWith("data:") && !src.startsWith("/")) return;
  const el = element(src, false, PROMPT_VOLUME);
  if (!el) return;
  try {
    stopAlarm();
    el.currentTime = 0;
    void el.play().catch((err) => console.error("[audio] preview failed:", err));
  } catch (err) {
    console.error("[audio] preview threw:", err);
  }
}

/** 把用户选的文件读成 data URL；超限或读失败返回 null（调用方提示文案） */
export function readSoundFile(file: File): Promise<string | null> {
  if (file.size > MAX_CUSTOM_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        resolve(result.startsWith("data:") ? result : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}
