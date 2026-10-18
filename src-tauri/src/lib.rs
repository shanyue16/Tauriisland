//! Tauri 后端入口 — Rust SMTC 直接调用 Windows 系统媒体控制 API。
//!
//! 架构变化：去掉了 Python sidecar，所有 SMTC 采集通过 Tauri command 暴露。
//! LRCLIB 歌词获取由前端直接 fetch（capabilities 已放行）。

mod fullscreen;
mod hotkeys;
mod notifications;
mod single_instance;
mod smtc;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
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

// ── 全屏隐藏 ────────────────────────────────────────────────

/// 同步「全屏时隐藏」开关（前端设置变化时调用；应用启动时也会推一次）。
///
/// 关掉开关会立即把岛恢复出来 —— 用户在全屏里改设置的路径不存在，
/// 但"关了开关却要等下一次全屏切换才回来"是不可接受的。
#[tauri::command]
fn set_fullscreen_hide(app: tauri::AppHandle, enabled: bool) {
    fullscreen::set_enabled(&app, enabled);
}

/// 前端「出场动画」跑完后的确认 —— 真正把窗口收起来的是这一步。
///
/// 为什么不直接在检测线程里 hide：hide() 一步到位，窗口一消失就没有东西可以动效了。
/// 所以改成「Rust 只发事件 → 前端播完动画回来确认 → Rust 才 hide」，
/// 并配了一条截止兜底（fullscreen.rs 的 HIDE_DEADLINE_MS）。
#[tauri::command]
fn commit_fullscreen_hide(app: tauri::AppHandle) {
    fullscreen::commit_hide(&app);
}

// ── 全局快捷键 ──────────────────────────────────────────────

/// 注册/改键全局快捷键（前端启动时推默认值，改键时推新值）。
///
/// 失败不会让命令返回 Err —— 而是 emit `hotkey://error`，由设置页显示
/// （键被其他程序占用这类问题用户必须看见，但不值得让前端 invoke 抛异常）。
#[tauri::command]
fn set_hotkeys(app: tauri::AppHandle, quit: String, toggle: String) {
    hotkeys::register(&app, &quit, &toggle);
}

// ── 入口 ────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例判定必须在任何窗口/托盘/线程创建之前 —— 第二个实例直接在这里退出，
    // 只负责把已有的那个叫醒（见 single_instance 模块注释）。
    single_instance::ensure_single_instance();

    let app = tauri::Builder::default()
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
            set_fullscreen_hide,
            commit_fullscreen_hide,
            set_hotkeys,
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

            // 单实例：监听「用户又点了一次应用」的信号，把窗口拉出来置前。
            single_instance::spawn_activation_listener(app.handle().clone());

            // 系统托盘：**失败绝不能带走整个应用**。
            // 历史故障（症状"窗口闪一下就消失"）：窗口已经在上面 show() 出来了，随后
            // `setup_tray(app)?` 的 `?` 把 Err 冒泡出 setup → run() 返回 Err →
            // `.expect("error while building tauri application")` panic → 进程退出。
            // 托盘图标只是个附属功能，它失败时打印一行警告继续跑。
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[tray] 托盘初始化失败（应用继续运行，可从任务栏图标以外的方式使用）: {e}");
            }

            // 全屏隐藏：常驻检测线程。放在这里而不是 lazy 启动，是因为它必须从
            // 第一秒就在看 —— 用户开游戏时不会先来点一下岛。
            fullscreen::spawn_watcher(app.handle().clone());

            // 全局快捷键：消息循环线程常驻。初始注册由前端启动时 invoke set_hotkeys
            // 推默认值（与 set_fullscreen_hide 同一模式）——键位保存在前端 store 里。
            hotkeys::spawn_listener(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // "所有窗口都关闭 → 退出"是 Tauri 的默认行为，但对托盘常驻的桌面小组件是错的：
        // 岛一旦被系统/桌面合成器收走（事件日志实测：同刻 dwm.exe 在 dwmcore.dll 里
        // APPCRASH，而本应用既无崩溃记录也无 WebView2 转储），进程会**静默**结束，
        // 用户只能重启 —— 表现正是"窗口闪一下就消失"。
        // 这里只拦"没有窗口了"这种自动退出；托盘「退出」走 app.exit(code)（code=Some），
        // 以及 QUITTING 标记，都照常退出。
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        // 窗口被系统销毁（合成器重启、被外部关闭）→ 自动重建，别让用户以为应用没了。
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == "main" => {
            if !QUITTING.load(Ordering::SeqCst) {
                eprintln!("[window] main 窗口被销毁 → 自动重建");
                show_or_create_island(app);
            }
        }
        _ => {}
    });
}

/// 用户主动退出（托盘「退出」/ 快捷键退出）时置位：此后不再拦 ExitRequested、也不重建窗口。
static QUITTING: AtomicBool = AtomicBool::new(false);

/// 主动退出入口：托盘「退出」与快捷键退出共用同一条路径。
/// 先置位再退出：否则 ExitRequested 会拦下这次退出，窗口重建也会被触发。
pub(crate) fn request_quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示灵动岛", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "隐藏灵动岛", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Tauriisland · 灵动岛")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_or_create_island(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_or_create_island(tray.app_handle());
            }
        });

    // 图标可能是 None（配置里没有可用 png 时）。原来这里 `.unwrap()` 会直接 panic，
    // 而它发生在窗口 show() 之后 —— 又是一次"闪一下就消失"。没有图标就不设图标。
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;

    Ok(())
}

/// 显示岛；**窗口已经不存在时按 tauri.conf.json 的配置把它重建出来**。
///
/// 为什么需要重建：窗口一旦被系统销毁（合成器重启、被外部关闭等），
/// `get_webview_window("main")` 就再也拿不到它，托盘「显示灵动岛」会变成一个
/// 点了没反应的空操作 —— 用户只能重启应用。配合 `run()` 里的 `prevent_exit`，
/// 岛被收走之后仍然可以从托盘找回。
fn show_or_create_island(app: &AppHandle) {
    // 全屏隐藏（含动画刚跑到一半）期间不响应：此时前端已把窗口滑到屏幕上方，
    // show() 出来是一片看不见的区域，用户会以为托盘菜单坏了。
    // 全屏结束或关掉开关时本模块自己会 restore，不需要这里插手。
    if fullscreen::is_hiding() {
        return;
    }
    // 快捷键手动隐藏期间的「显示」不需要在这里拦：toggle_island 走的是
    // is_manual_hidden() 分支；托盘「显示」则视为用户意志，清除手动隐藏标记后照常显示。
    hotkeys::clear_manual_hidden();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // 必须与 tauri.conf.json 的 app.windows[0] 逐项一致：decorations / transparent /
    // alwaysOnTop / skipTaskbar / shadow / min / max，少一项重建出来的岛就会变样
    // （例如带系统边框、或无法置顶、或尺寸不受钳制）。
    let (x, y) = island_initial_pos(app);
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Tauriisland")
        .inner_size(220.0, 48.0)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .min_inner_size(100.0, 20.0)
        .max_inner_size(600.0, 320.0)
        .build()
    {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("[window] 重建 main 窗口失败: {e}"),
    }
}

/// 岛的首屏摆放：水平居中、y = 8（与 setup 分支里的初始摆放同一套算法）。
fn island_initial_pos(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let screen_w_logical = monitor.size().width as f64 / scale;
        return ((screen_w_logical - 220.0) / 2.0, 8.0);
    }
    (100.0, 8.0)
}
