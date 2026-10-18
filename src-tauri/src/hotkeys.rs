//! 全局快捷键：ALT+Z 退出应用、ALT+C 显示/隐藏灵动岛（可在设置里改键）。
//!
//! 实现方式：Win32 `RegisterHotKey` + 专用线程 `GetMessageW` 循环
//! （不引入 tauri-plugin-global-shortcut 依赖、不动 capability）。
//!
//! 线程归属（关键坑，改这里前先读）：`RegisterHotKey(None, …)` 生成的 WM_HOTKEY
//! 投递到**调用线程**的消息队列。前端 invoke 的命令跑在 tokio/主线程上，
//! 若直接在命令里注册，消息永远到不了本模块的监听线程 —— 注册成功却永远不触发。
//! 所以注册/注销一律写进 `PENDING_CMD`，由监听线程在自己的消息循环里执行；
//! 监听线程用 50ms 定时器（WM_TIMER）兜底取命令，顺带省掉 PostThreadMessageW
//! （那需要 Win32_System_Threading 的线程号 feature）。
//!
//! 其余关键约束（历史坑）：
//! - 注册失败（键被其他程序占用）**必须上报可见**：emit `hotkey://error` 给设置页显示，
//!   不能静默吞掉；两键全部成功才 emit `hotkey://registered` 让设置页清掉旧错误。
//! - 快捷键录制期间前端传两个空键名 = 静默卸载全部热键（register 的全空分支）。
//!   不卸的话用户按下 Alt+Z 录制新键时旧热键会先触发（实测直接退出应用）——
//!   WM_HOTKEY 是系统级的，DOM keydown 的 preventDefault 拦不住。
//! - 改键 = 先注销旧键再注册新键，两个键要么都成功要么整体回滚，
//!   避免"一个生效一个失效"的半残状态。
//! - 快捷键手动隐藏后全屏检测线程不得抢回显示：以 `MANUAL_HIDDEN` 标记区分
//!   （fullscreen.rs 的 restore 与 lib.rs 的 show_or_create_island 都要看它）。
//! - 退出走 `QUITTING` + `app.exit(0)`，与托盘「退出」完全同一条路径。
//! - 窗口显示/创建一律 marshal 回主线程（`run_on_main_thread`），不在监听线程直接碰。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
// RegisterHotKey 一族在 KeyboardAndMouse 模块（不是 WindowsAndMessaging）
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, SetTimer, TranslateMessage, MSG,
};

/// 热键 id：退出 / 显示隐藏。GetMessageW 循环按 id 分发。
const ID_QUIT: i32 = 1;
const ID_TOGGLE: i32 = 2;

/// WM_HOTKEY 消息号。
const WM_HOTKEY: u32 = 0x0312;
/// WM_TIMER 消息号（定时器兜底取待办命令用）。
const WM_TIMER: u32 = 0x0113;
/// 命令兜底轮询周期（毫秒）：改键后最多这个延迟生效。50ms 是为压住
/// 「点录制框后立刻按键」的竞态 —— 热键晚卸 200ms 就可能被快手按出来。
const CMD_POLL_MS: u32 = 50;
/// 定时器 id（本线程私有）。
const ID_CMD_TIMER: usize = 1;

/// 快捷键手动隐藏了岛：全屏检测线程别把它抢回来。
static MANUAL_HIDDEN: AtomicBool = AtomicBool::new(false);

/// 待监听线程执行的注册命令。改键是"最新覆盖旧的"语义，不需要队列。
enum Cmd {
    Register {
        quit: (u32, u32),
        toggle: (u32, u32),
        quit_text: String,
        toggle_text: String,
    },
    Unregister,
}

static PENDING_CMD: Mutex<Option<Cmd>> = Mutex::new(None);

/// 解析文本组合键（如 "Alt+Z"、"Ctrl+Shift+F1"）成 Win32 修饰符 + 虚拟键码。
///
/// 支持修饰符：Alt / Ctrl(Control) / Shift / Win(Meta/Super)；主键：A-Z / 0-9 / F1-F12。
/// 至少带一个修饰键（裸主键全局热键会劫持打字，前端也拦了，这里是手改
/// settings.json 的兜底）。解析失败返回 None（前端把这类值当"无效快捷键"处理）。
fn parse_combo(text: &str) -> Option<(u32, u32)> {
    let mut mods = 0u32;
    let mut vk: Option<u32> = None;

    for part in text.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "alt" => mods |= MOD_ALT.0 as u32,
            "ctrl" | "control" => mods |= MOD_CONTROL.0 as u32,
            "shift" => mods |= MOD_SHIFT.0 as u32,
            "win" | "meta" | "super" => mods |= MOD_WIN.0 as u32,
            _ => {
                if lower.len() == 1 {
                    let c = lower.chars().next().unwrap();
                    if c.is_ascii_alphanumeric() {
                        vk = Some(c.to_ascii_uppercase() as u32);
                        continue;
                    }
                }
                // F1-F12（VK_F1 = 0x70）
                if let Some(num) = lower.strip_prefix('f') {
                    if let Ok(n) = num.parse::<u8>() {
                        if (1..=12).contains(&n) {
                            vk = Some(0x70 + (n as u32 - 1));
                            continue;
                        }
                    }
                }
                return None;
            }
        }
    }

    if mods == 0 {
        return None;
    }
    vk.map(|v| (mods, v))
}

/// 登记（或改键后重新登记）全局快捷键 —— 真正的 RegisterHotKey 由监听线程执行
/// （线程归属坑见文件头）。解析失败立即 emit `hotkey://error`。
pub fn register(app: &AppHandle, quit_text: &str, toggle_text: &str) {
    // 两个键都传空 = 静默卸载全部热键（快捷键录制期间用，见 ShortcutsSettings）。
    if quit_text.trim().is_empty() && toggle_text.trim().is_empty() {
        if let Ok(mut slot) = PENDING_CMD.lock() {
            *slot = Some(Cmd::Unregister);
        }
        return;
    }
    let Some((quit_mods, quit_vk)) = parse_combo(quit_text) else {
        let _ = app.emit(
            "hotkey://error",
            format!("无效的退出快捷键: {quit_text}（需要修饰键+主键，如 Alt+Z）"),
        );
        return;
    };
    let Some((toggle_mods, toggle_vk)) = parse_combo(toggle_text) else {
        let _ = app.emit(
            "hotkey://error",
            format!("无效的显示/隐藏快捷键: {toggle_text}（需要修饰键+主键，如 Alt+C）"),
        );
        return;
    };
    if let Ok(mut slot) = PENDING_CMD.lock() {
        *slot = Some(Cmd::Register {
            quit: (quit_mods, quit_vk),
            toggle: (toggle_mods, toggle_vk),
            quit_text: quit_text.to_string(),
            toggle_text: toggle_text.to_string(),
        });
    }
}

/// 登记注销全部全局快捷键（改键时由 Register 流程先注销再注册；退出不需要 —— 进程退出系统自动回收）。
#[allow(dead_code)]
pub fn unregister() {
    if let Ok(mut slot) = PENDING_CMD.lock() {
        *slot = Some(Cmd::Unregister);
    }
}

/// 当前是否处于快捷键手动隐藏状态（供 fullscreen.rs 的 restore 与
/// lib.rs 的 show_or_create_island 判定）。
pub fn is_manual_hidden() -> bool {
    MANUAL_HIDDEN.load(Ordering::SeqCst)
}

/// 清除手动隐藏标记（托盘「显示」等外部显式显示走这条）。
pub fn clear_manual_hidden() {
    MANUAL_HIDDEN.store(false, Ordering::SeqCst);
}

/// 专用消息循环线程：`GetMessageW` 阻塞等热键消息，按 id 分发。
pub fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            // 先建定时器：保证「待办命令永远能被取走」（消息循环不会因没消息而死等）。
            SetTimer(None, ID_CMD_TIMER, CMD_POLL_MS, None);
            let mut msg = MSG::default();
            // GetMessageW 返回 0 = WM_QUIT，-1 = 错误；两者都退出循环。
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                match msg.message {
                    WM_HOTKEY => match msg.wParam.0 as i32 {
                        ID_QUIT => quit_app(&app),
                        ID_TOGGLE => toggle_island(&app),
                        _ => {}
                    },
                    WM_TIMER => {
                        // 在**本线程**执行 Register/Unregister —— WM_HOTKEY 才会投递到本线程。
                        let cmd = PENDING_CMD.lock().ok().and_then(|mut g| g.take());
                        if let Some(cmd) = cmd {
                            apply_cmd(&app, cmd);
                        }
                    }
                    _ => {}
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    });
}

/// 在监听线程上真正执行注册/注销。
///
/// 两键要么都注册成功、要么整体回滚并报错 —— 避免"一个生效一个失效"的半残状态。
fn apply_cmd(app: &AppHandle, cmd: Cmd) {
    do_unregister();
    if let Cmd::Register {
        quit,
        toggle,
        quit_text,
        toggle_text,
    } = cmd
    {
        unsafe {
            if let Err(e) = RegisterHotKey(None, ID_QUIT, HOT_KEY_MODIFIERS(quit.0), quit.1) {
                let _ = app.emit(
                    "hotkey://error",
                    format!("退出快捷键 {quit_text} 注册失败（可能被其他程序占用）: {e}"),
                );
                return;
            }
            if let Err(e) = RegisterHotKey(None, ID_TOGGLE, HOT_KEY_MODIFIERS(toggle.0), toggle.1) {
                let _ = UnregisterHotKey(None, ID_QUIT);
                let _ = app.emit(
                    "hotkey://error",
                    format!("显示/隐藏快捷键 {toggle_text} 注册失败（可能被其他程序占用）: {e}"),
                );
                return;
            }
        }
        // 全部成功才通知设置页清掉旧错误
        let _ = app.emit("hotkey://registered", ());
    }
}

fn do_unregister() {
    unsafe {
        let _ = UnregisterHotKey(None, ID_QUIT);
        let _ = UnregisterHotKey(None, ID_TOGGLE);
    }
}

/// 退出应用：与托盘「退出」同一条路径（marshal 回主线程）。
fn quit_app(app: &AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::request_quit(&inner);
    });
}

/// 显示/隐藏切换（窗口操作 marshal 回主线程）。
fn toggle_island(app: &AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if is_manual_hidden() {
            clear_manual_hidden();
            crate::show_or_create_island(&inner);
            return;
        }
        if let Some(window) = inner.get_webview_window("main") {
            let _ = window.hide();
            MANUAL_HIDDEN.store(true, Ordering::SeqCst);
        }
    });
}
