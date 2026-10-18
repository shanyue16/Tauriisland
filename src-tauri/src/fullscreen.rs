//! 全屏隐藏 — 检测系统「当前不应被打扰」状态，全屏时把岛收起来。
//!
//! 判据用 `SHQueryUserNotificationState()`：Windows 官方对「现在该不该弹通知」的
//! 权威回答，无参数、进程内查询。它一次覆盖三种真实场景：
//!   `QUNS_BUSY`(2)                    全屏演示 / 独占程序
//!   `QUNS_RUNNING_D3D_FULL_SCREEN`(3) D3D 全屏（游戏）
//!   `QUNS_PRESENTATION_MODE`(4)       演示模式（PPT 放映）
//!
//! 故意不用「自己算 `GetForegroundWindow` + 和显示器矩形比大小」那条常见路：
//! 多显示器拼屏、无边框窗口、任务栏在侧边等情况下会把普通窗口误判成全屏（反之亦然），
//! 而全屏隐藏的代价是**用户的岛不见了**，误判不可接受。
//!
//! 隐藏用 `Window::hide()` 而不是 `set_opacity(0)`：后者窗口仍占着 always-on-top 的
//! 命中区，会吃掉全屏应用的点击（用户表现为"游戏里点不动"）。
//!
//! ## 隐藏为什么要"两拍"
//!
//! `hide()` 是一步到位的，窗口一消失就没有任何东西可以动效了。所以本模块**不**在
//! 判定到全屏时立刻 hide，而是：
//!   ① 发 `fullscreen://changed(true)` 让前端把「淡出 + 向上滑出」跑完；
//!   ② 前端回来调 `commit_fullscreen_hide` 才真正 `hide()`。
//! 恢复方向不需要握手（`show()` 之后前端再把窗口滑回来即可），但**如果前端根本没在跑**
//! （未装监听 / webview 卡死 / 事件没送到），岛就会一直浮在全屏应用上面 ——
//! 所以这里还压了一条 `HIDE_DEADLINE_MS` 的截止兜底。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// 轮询间隔。全屏切换是「用户按一下」的量级，500ms 足够跟手；
/// `SHQueryUserNotificationState` 只是读进程内状态、无 IPC，开销可忽略。
const POLL_MS: u64 = 500;

/// 等前端确认「出场动画已跑完」的上限。
///
/// 前端在动画结束 + 60ms 余量后回来确认，最长的一档（动画速度"慢"）约 440ms，
/// 这里给到 1200ms 留足余量；超时就直接 hide —— 宁可少一段动画，
/// 也不能让岛一直盖在全屏应用上。
const HIDE_DEADLINE_MS: u64 = 1200;

/// 功能总开关（由前端设置同步过来）。默认 `true`，与 `DEFAULT_SETTINGS.hideOnFullscreen` 一致。
static ENABLED: AtomicBool = AtomicBool::new(true);

/// 当前是否**由本模块**把窗口藏起来了。
///
/// 两个作用：① 避免重复 hide/show；② 区分「我们藏的还是用户用托盘藏的」——
/// 托盘隐藏时这个标记是 false，退出全屏就不该把岛擅自弹回来。
static HIDDEN: AtomicBool = AtomicBool::new(false);

/// 已经通知前端"要藏了"、但还没真正 hide 的时间点。
/// `Some(t)` = 自 t 起挂起中；`None` = 没有挂起的隐藏请求。
static PENDING: Mutex<Option<Instant>> = Mutex::new(None);

/// 查询「系统现在是否处于不应打扰的全屏状态」。
///
/// 比对裸数值而不是 `QUNS_*` 常量符号：语义由 MS Learn 的
/// `QUERY_USER_NOTIFICATION_STATE` 定义，而常量在 windows crate 各版本里的
/// 导入路径偶有出入；数值本身是 ABI 稳定的。
#[cfg(windows)]
fn is_fullscreen_now() -> bool {
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    // SAFETY: 无参数、只读的系统状态查询，任何线程可调，不会失败于非法入参。
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => matches!(state.0, 2 | 3 | 4),
        // 无 shell 的会话（服务、部分远程桌面）会返回 Err —— 视为"非全屏"，
        // 宁可不隐藏也不要卡住岛的显示。
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn is_fullscreen_now() -> bool {
    false
}

/// 前端设置同步入口。关掉开关时，若岛正被藏着（或正挂着隐藏请求）就立刻恢复。
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    if !enabled {
        restore(app);
    }
}

/// 真正把窗口收起来。幂等：已经在藏的状态下重复调用什么都不做。
fn hide_now(app: &AppHandle) {
    if HIDDEN.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 判定到全屏：只**挂起**隐藏请求并发事件，把真正的 hide 让给前端的出场动画。
fn request_hide(app: &AppHandle) {
    if HIDDEN.load(Ordering::SeqCst) {
        return;
    }
    *PENDING.lock().unwrap() = Some(Instant::now());
    // 通知前端"全屏了" → ① 播出场动画 ② 通知提醒改为只进列表、不弹
    let _ = app.emit("fullscreen://changed", true);
}

/// 前端出场动画结束后的确认，是窗口被收起的正常入口（另一条是截止兜底）。
pub fn commit_hide(app: &AppHandle) {
    let pending = PENDING.lock().unwrap().take();
    if pending.is_some() {
        hide_now(app);
    }
}

/// 全屏隐藏是否正处于「挂起中」或「已生效」。
///
/// 托盘「显示灵动岛」用它挡一下：此时窗口停在屏幕上方（前端把它滑出可视区了），
/// `show()` 出来也是一片看不见的区域，用户会以为托盘菜单坏了。
pub fn is_hiding() -> bool {
    HIDDEN.load(Ordering::SeqCst) || PENDING.lock().unwrap().is_some()
}

/// 把岛恢复出来。
///
/// **必须重设 `always_on_top`**：窗口 hide 之后再 show，层叠顺序不保证还原，
/// 实测会出现"岛回来了但沉在其它窗口底下"（用户表现为"隐藏过一次就再也不置顶了"）。
fn restore(app: &AppHandle) {
    // 先撤掉还没落地的隐藏请求：全屏可能正好在前端动画跑到一半时结束了。
    *PENDING.lock().unwrap() = None;
    if HIDDEN.swap(false, Ordering::SeqCst) {
        // 快捷键手动隐藏优先：全屏检测不得把用户藏起来的岛抢回来
        // （规格硬约束；否则 Alt+C 藏好后看个 PPT 回来岛又自己蹦出来）。
        if !crate::hotkeys::is_manual_hidden() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_always_on_top(true);
            }
        }
    }
    // 无论刚才是否真的藏过都要发：出场动画可能只跑到一半（窗口还没 hide），
    // 前端得据此把窗口滑回来、把透明度还原。同时也是"提醒恢复弹出"的信号。
    let _ = app.emit("fullscreen://changed", false);
}

/// 启动常驻全屏检测线程。
///
/// 不新增进程：一条 sleep 轮询线程，`run()` 返回即随进程一起结束，无需额外清理。
/// 窗口被销毁重建（合成器重启）时不重置标记 —— `get_webview_window` 拿不到窗口
/// 就什么都不做，等下一次状态翻转再恢复。
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let deadline = Duration::from_millis(HIDE_DEADLINE_MS);
        let mut was_fullscreen = false;
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));

            // 截止兜底：前端没回来确认（没装监听 / webview 卡住 / 事件丢了）
            // 也要把岛藏掉，否则它会一直浮在全屏应用上面。
            // 取走和判定必须在同一把锁里 —— 否则可能和 commit_hide 抢同一个请求，
            // 出现"前端刚确认、这里又判一次"的重复路径（虽然幂等，但没必要）。
            let overdue = {
                let mut pending = PENDING.lock().unwrap();
                let over = matches!(*pending, Some(at) if at.elapsed() >= deadline);
                if over {
                    *pending = None;
                }
                over
            };
            if overdue {
                hide_now(&app);
            }

            if !ENABLED.load(Ordering::SeqCst) {
                // 开关关闭期间不做任何事；同时把状态归零，避免关掉再打开时
                // `was_fullscreen` 还停在旧值、把紧邻的一次翻转吃掉。
                was_fullscreen = false;
                continue;
            }

            let fullscreen = is_fullscreen_now();
            if fullscreen == was_fullscreen {
                continue;
            }
            was_fullscreen = fullscreen;

            if fullscreen {
                request_hide(&app);
            } else {
                restore(&app);
            }
        }
    });
}
