//! Tauri 后端入口 — Rust SMTC 直接调用 Windows 系统媒体控制 API。
//!
//! 架构变化：去掉了 Python sidecar，所有 SMTC 采集通过 Tauri command 暴露。
//! LRCLIB 歌词获取由前端直接 fetch（capabilities 已放行）。

mod smtc;

use std::path::{Path, PathBuf};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    LogicalPosition, LogicalSize, Manager, Runtime, WindowEvent,
};

// ── Tauri 命令 ─────────────────────────────────────────────

/// 获取当前音乐播放信息 — Rust SMTC，自动 spawn_blocking 避免阻塞主线程。
#[tauri::command]
async fn get_music() -> Result<smtc::MusicInfo, String> {
    smtc::get_music_info().await
}

/// SMTC 播放控制 — spawn_blocking + WinRT STA。
#[tauri::command]
async fn control_music(action: String) -> Result<(), String> {
    smtc::control_music(action).await
}

/// seek 到指定秒数（TryChangePlaybackPositionAsync）。
#[tauri::command]
async fn seek_music(position: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || smtc::seek_music(position))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 查询 sidecar 运行状态 — 保留命令名但返回 disabled。
/// 前端可以调用来判断是否应该降级用旧 HTTP API（已不需要）。
#[tauri::command]
fn sidecar_status() -> serde_json::Value {
    serde_json::json!({
        "running": false,
        "reason": "rust-native",
        "note": "Python sidecar 已移除，SMTC 由 Rust 原生实现"
    })
}

// ── 入口 ────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            get_music,
            control_music,
            seek_music,
            sidecar_status,
        ])
        .setup(move |app| {
            // 初始隐藏 → 防止窗口在 (0,0) 闪一下
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let screen_w_logical = monitor.size().width as f64 / scale;

                    let win_w = 220.0_f64;
                    let win_h = 48.0_f64;
                    let x = (screen_w_logical - win_w) / 2.0;

                    let _ = window.set_size(LogicalSize::new(win_w, win_h));
                    let _ = window.set_position(LogicalPosition::new(x, 8.0));
                }
                let _ = window.show();
            }

            // 系统托盘
            setup_tray(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示灵动岛", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏灵动岛", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Tauriisland · 灵动岛")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[allow(dead_code)]
fn _unused_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}
