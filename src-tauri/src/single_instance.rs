//! 单实例守卫（Windows 命名事件）。
//!
//! 为什么不用插件：`tauri-plugin-single-instance` 会给多平台加一串依赖，这里只需要
//! Windows 上「第二个实例发现第一个已经在跑 → 叫醒它 → 自己退出」。
//!
//! 用**命名事件**而不是互斥量：
//! - 事件名存在 ⟺ 第一个实例还活着（内核对象随最后一个句柄关闭而消失，崩溃也不会留残骸）；
//! - 第二个实例 `OpenEventW` 成功就 `SetEvent`，第一个实例的监听线程收到后把窗口拉出来
//!   并置前，比「静默退出」符合直觉。
//!
//! 非 Windows 平台不做限制（macOS/Linux 由各自的桌面环境管，不属于本次需求）。

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use tauri::Manager;
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
    };

    /// `Local\` 前缀 = 本会话内唯一（同一用户登录的多个会话互不干扰，也不需要管理员权限）。
    const EVENT_NAME: windows::core::PCWSTR = w!("Local\\TauriIsland.Activate");

    static ACTIVATE_EVENT: OnceLock<usize> = OnceLock::new();

    /// 已有实例在跑 → 叫醒它并返回 true（调用方应当直接退出）。
    pub fn try_activate_existing() -> bool {
        let handle = match unsafe { OpenEventW(EVENT_MODIFY_STATE, false, EVENT_NAME) } {
            Ok(h) => h,
            Err(_) => return false,
        };
        // 叫醒可能失败（对方正在退出），失败也照样退出：文档要求就是「不允许两个实例」。
        let _ = unsafe { SetEvent(handle) };
        let _ = unsafe { CloseHandle(handle) };
        true
    }

    /// 第一个实例：创建事件并常驻持有句柄。句柄故意不关闭，随进程退出释放。
    pub fn create_activate_event() {
        match unsafe { CreateEventW(None, false, false, EVENT_NAME) } {
            Ok(handle) => {
                let _ = ACTIVATE_EVENT.set(handle.0 as usize);
            }
            Err(e) => eprintln!("[single-instance] 创建命名事件失败（将允许多开）: {e}"),
        }
    }

    /// 监听「第二个实例被启动」的信号：把主窗口显示出来并置前。
    pub fn spawn_activation_listener(app: tauri::AppHandle) {
        // 只把裸指针值（usize）搬进线程：HANDLE 本身不是 Send，按 usize 传递再就地重建。
        let Some(raw) = ACTIVATE_EVENT.get().copied() else {
            return;
        };
        std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || loop {
                let handle = HANDLE(raw as *mut _);
                // 自动重置事件：等到信号后事件自动回到无信号态。
                let _ = unsafe { WaitForSingleObject(handle, u32::MAX) };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })
            .ok();
    }
}

/// 应用入口调用：非首实例直接退出（不返回）。
pub fn ensure_single_instance() {
    #[cfg(windows)]
    {
        if imp::try_activate_existing() {
            std::process::exit(0);
        }
        imp::create_activate_event();
    }
}

/// 首个实例在 setup 里调用，注册「被叫醒」的处理。
pub fn spawn_activation_listener(_app: tauri::AppHandle) {
    #[cfg(windows)]
    imp::spawn_activation_listener(_app);
}
