import { invoke } from "@tauri-apps/api/core";
import type { MusicData } from "../types/music";

/**
 * 从 Rust SMTC 后端获取当前音乐播放信息。
 * 直接调用 Tauri command，不再需要 Python sidecar。
 */
export async function fetchMusic(): Promise<MusicData> {
  try {
    const data = await invoke<MusicData>("get_music");
    return data;
  } catch (err) {
    console.error("[music] invoke get_music failed:", err);
    return {
      active: false,
      app_name: null,
      title: null,
      artist: null,
      album: null,
      cover_url: null,
      playing: false,
      position: 0,
      duration: 0,
      timeline_lut: null,
      timestamp: Date.now(),
    };
  }
}

/**
 * SMTC 播放控制 — 通过 Tauri command 转发到 Rust 后端。
 */
export async function controlMusic(
  action: "play" | "pause" | "toggle" | "stop" | "next" | "prev"
): Promise<{ ok: boolean; error?: string }> {
  try {
    await invoke("control_music", { action });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
