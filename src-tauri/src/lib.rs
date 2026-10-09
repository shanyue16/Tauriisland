//! Tauri 后端入口 — Rust SMTC 直接调用 Windows 系统媒体控制 API。
//!
//! 架构变化：去掉了 Python sidecar，所有 SMTC 采集通过 Tauri command 暴露。
//! LRCLIB 歌词获取由前端直接 fetch（capabilities 已放行）。

mod notifications;
mod smtc;

use std::path::{Path, PathBuf};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, Runtime,
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

// ── 系统通知 ────────────────────────────────────────────────

/// 读取系统通知（最新在前）。
///
/// 数据源是 `wpndatabase.db` 的快照解析，不是官方 UserNotificationListener
/// （未打包应用拿不到该权限，详见 notifications.rs 模块注释）。读取要复制约
/// 3.2MB 到临时目录，属于较重的操作，前端轮询间隔不要低于 5s。
///
/// 失败一律返回 Err(String)，前端拿到错误显示空态、不刷屏（与日历 API 同策略）。
#[tauri::command]
async fn get_notifications(limit: Option<usize>) -> Result<Vec<notifications::NotificationItem>, String> {
    let limit = limit.unwrap_or(20);
    tauri::async_runtime::spawn_blocking(move || notifications::list_notifications(limit))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 通知库是否变化 —— 只 stat 文件，几乎免费（微秒级）。
///
/// 前端用两级轮询压延迟：高频调本命令（约 1.5s 一次），只有 `changed` 为真时
/// 才调 `get_notifications` 做完整读取（复制约 3.3MB + sqlite 查询）。
/// 这样"新消息出现"的延迟 ≈ 高频间隔，而不是完整读取的间隔。
///
/// 变化时顺带 emit `notifications://changed` 事件，供**通知弹窗**订阅
/// （尚未接 UI，见 docs/notifications-plan.md 的"新通知提醒"）。
#[derive(serde::Serialize)]
struct FingerprintResult {
    changed: bool,
}

static LAST_FINGERPRINT: std::sync::Mutex<Option<(u64, u64, u64)>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn check_notifications(app: tauri::AppHandle) -> Result<FingerprintResult, String> {
    let fp = tauri::async_runtime::spawn_blocking(notifications::change_fingerprint)
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?;

    let changed = {
        let mut last = LAST_FINGERPRINT
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let changed = last.map(|prev| prev != fp).unwrap_or(true);
        *last = Some(fp);
        changed
    };

    if changed {
        // 事件名带命名空间，避免和其它插件事件撞名。当前没有订阅者也不报错。
        let _ = app.emit("notifications://changed", ());
    }

    Ok(FingerprintResult { changed })
}

// ── 发送系统通知 ────────────────────────────────────────────

/// 发一条系统通知。
///
/// 走 tauri-plugin-notification（内部是 notify-rust）。desktop 端只支持
/// title/body/icon/sound，`schedule`/`group`/action 一律被忽略。
///
/// 注意两点（实测插件源码，见 docs/notifications-plan.md §3.5）：
/// ① `request_permission()` 在 desktop 上直接返回 Granted、不弹系统提示，所以
///    调用方不需要做权限引导 UI；
/// ② 插件只在 exe 所在目录**不以 `\target\debug` / `\target\release` 结尾**时才设置
///    AUMID，也就是 `npm run tauri dev` 跑起来时通知归属的应用身份可能不准 ——
///    不影响能否弹出，安装版正常。
#[tauri::command]
async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(title);
    if let Some(b) = body {
        if !b.is_empty() {
            builder = builder.body(b);
        }
    }
    builder.show().map_err(|e| format!("发送通知失败: {}", e))
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
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_music,
            control_music,
            seek_music,
            sidecar_status,
            get_notifications,
            check_notifications,
            send_notification,
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
