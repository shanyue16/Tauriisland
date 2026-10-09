//! Windows SMTC (System Media Transport Controls) 采集模块。
//!
//! 直接调用 WinRT GlobalSystemMediaTransportControlsSessionManager。
//! 参考: eIsland SmtcSessionMonitor.cs / SmtcController.cs
//!
//! ⚠️ 关键架构：SMTC 的 IAsyncOperation 完成回调只会投递到调用线程所在的 STA
//! 消息队列，因此必须跑在**常驻 STA 线程 + 消息泵**上（与 eIsland 的 C# STA 线程
//! 同一思路）。在无消息泵的线程（MTA 或裸 STA）上 RequestAsync 永不完成。

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use windows::Foundation::{AsyncStatus, IAsyncAction, IAsyncOperation};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

/// 封面读取状态（诊断用）
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub enum CoverStatus {
    #[default]
    Ok,
    /// 源根本没发布 Thumbnail（PotPlayer 典型）
    NoThumbnail,
    /// OpenReadAsync 失败
    OpenFailed,
    /// DataReader 读流失败
    ReadFailed,
    /// 超 8MB 上限
    TooLarge,
}

impl CoverStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NoThumbnail => "no-thumbnail",
            Self::OpenFailed => "open-failed",
            Self::ReadFailed => "read-failed",
            Self::TooLarge => "too-large",
        }
    }
}

/// 采集中间结果
#[derive(Debug, Clone, Serialize, Default)]
pub struct MusicInfo {
    pub active: bool,
    pub app_name: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub cover_status: Option<String>,
    pub playing: bool,
    /// 秒
    pub position: f64,
    /// 秒
    pub duration: f64,
    /// 秒，SMTC 五字段
    pub min_seek: Option<f64>,
    pub max_seek: Option<f64>,
    /// Unix ms
    pub timeline_lut: Option<i64>,
    pub timestamp: i64,
    /// 诊断信息：SMTC 不可用时给出原因，供 UI 提示
    pub diag: Option<String>,
    /// 会话枚举诊断（仅排查用，UI 不渲染）：
    /// 形如 `sessions=2; current=none; #0(cloudmusic.exe)|t=歌名|a=歌手|img=1; picked #0 via=title`
    pub sessions_diag: Option<String>,
}

/// sameTrack 兜底缓存
#[derive(Debug, Clone, Default)]
struct LastMusic {
    title: Option<String>,
    artist: Option<String>,
    position: f64,
    duration: f64,
    cover_url: Option<String>,
}

static LAST_MUSIC: OnceLock<Mutex<Option<LastMusic>>> = OnceLock::new();
fn last_music_lock() -> &'static Mutex<Option<LastMusic>> {
    LAST_MUSIC.get_or_init(|| Mutex::new(None))
}

/// 封面缓存: (title, artist, data_url)
static COVER_CACHE: OnceLock<Mutex<Option<(String, String, String)>>> = OnceLock::new();
fn cover_cache_lock() -> &'static Mutex<Option<(String, String, String)>> {
    COVER_CACHE.get_or_init(|| Mutex::new(None))
}

/// 同一 track 封面读取失败时的重试计数器（10 次 ≈ 5s 后放弃）
static COVER_RETRY: OnceLock<Mutex<std::collections::HashMap<(String, String), u32>>> = OnceLock::new();
fn cover_retry_lock() -> &'static Mutex<std::collections::HashMap<(String, String), u32>> {
    COVER_RETRY.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 变更计数器
static CHANGE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn increment_change_counter() {
    CHANGE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

// ============ WinRT 辅助 ============

fn rt_to_string(s: windows::core::HSTRING) -> Option<String> {
    let v = s.to_string();
    if v.is_empty() { None } else { Some(v) }
}

fn timespan_to_seconds(ts: windows::Foundation::TimeSpan) -> f64 {
    ts.Duration as f64 / 10_000_000.0
}

fn playback_status_to_bool(status: GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> bool {
    matches!(
        status,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
    )
}

/// 在当前线程执行 CoInitializeEx(STA)：SMTC 的 WinRT 完成回调经消息泵送达。
fn com_init_current_thread() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

/// 抽干并派发本线程消息队列 —— STA 线程上 WinRT 异步完成靠它送达。
fn pump_messages() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn timeout_error(what: &str) -> windows::core::Error {
    windows::core::Error::new(
        windows::core::HRESULT(0x800705B4u32 as i32), // WAIT_TIMEOUT
        format!("WinRT {} timeout", what),
    )
}

/// 同步等待 IAsyncOperation<T>：边抽消息边查状态（STA 消息泵模式）。
fn wait_async<T: windows::core::RuntimeType>(
    op: &IAsyncOperation<T>,
    timeout_ms: u64,
) -> windows::core::Result<T> {
    let start = std::time::Instant::now();
    loop {
        pump_messages();
        match op.Status()? {
            AsyncStatus::Completed => return op.GetResults(),
            AsyncStatus::Error => {
                let hr = op.ErrorCode().unwrap_or_default();
                return Err(windows::core::Error::from(hr));
            }
            AsyncStatus::Canceled => {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x80004004u32 as i32), // E_ABORT
                    "WinRT operation canceled",
                ))
            }
            _ => {
                if start.elapsed().as_millis() > timeout_ms as u128 {
                    return Err(timeout_error("operation"));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// 同步等待 IAsyncAction（如 DataReader.LoadAsync）—— 同上，边抽消息边等。
fn wait_async_action(op: &IAsyncAction, timeout_ms: u64) -> windows::core::Result<()> {
    let start = std::time::Instant::now();
    loop {
        pump_messages();
        match op.Status()? {
            AsyncStatus::Completed => return Ok(()),
            AsyncStatus::Error => {
                let hr = op.ErrorCode().unwrap_or_default();
                return Err(windows::core::Error::from(hr));
            }
            AsyncStatus::Canceled => {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x80004004u32 as i32),
                    "WinRT action canceled",
                ))
            }
            _ => {
                if start.elapsed().as_millis() > timeout_ms as u128 {
                    return Err(timeout_error("action"));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

// ============ thumbnail 读取（按规格重写） ============
// 参考 eIsland SmtcController.cs:190-212 — 8MB 上限，兼容多种流

const MAX_COVER_BYTES: usize = 8 * 1024 * 1024; // 8MB

/// 从 IRandomAccessStreamWithContentType 读封面，返回 (data_url, CoverStatus)
fn read_thumbnail_base64(
    stream: windows::Storage::Streams::IRandomAccessStreamWithContentType,
) -> (Option<String>, CoverStatus) {
    // 1. Size：有些播放器的流不报长度（返回 0），此时按上限试探读，读到多少算多少
    let reported = stream.Size().ok().unwrap_or(0) as usize;
    if reported > MAX_COVER_BYTES {
        return (None, CoverStatus::TooLarge);
    }
    let want = if reported > 0 { reported } else { MAX_COVER_BYTES };

    // 2. 用 GetInputStreamAt(0) 拿 IInputStream — 比直接喂 IRandomAccessStream 兼容性好
    let input = match stream.GetInputStreamAt(0).ok() {
        Some(i) => i,
        None => return (None, CoverStatus::OpenFailed),
    };

    // 3. DataReader 读入
    let reader = match DataReader::CreateDataReader(&input).ok() {
        Some(r) => r,
        None => return (None, CoverStatus::ReadFailed),
    };

    let load_op = match reader.LoadAsync(want as u32).ok() {
        Some(op) => op,
        None => return (None, CoverStatus::ReadFailed),
    };

    // 等 LoadAsync（Completed 回调 + 超时）
    use windows::core::Interface;
    let load_action: IAsyncAction = match load_op.cast() {
        Ok(a) => a,
        Err(_) => return (None, CoverStatus::ReadFailed),
    };
    if wait_async_action(&load_action, 3000).is_err() {
        return (None, CoverStatus::ReadFailed);
    }

    // 实际可读字节数：流报长度时按上报值，未报长度时以 LoadAsync 载入量为准
    let size = if reported > 0 {
        reported
    } else {
        reader.UnconsumedBufferLength().unwrap_or(0) as usize
    };
    if size == 0 {
        let _ = reader.DetachStream();
        return (None, CoverStatus::NoThumbnail);
    }

    let mut buffer = vec![0u8; size];
    if reader.ReadBytes(&mut buffer).is_err() {
        return (None, CoverStatus::ReadFailed);
    }

    // DetachStream 释放 reader
    let _ = reader.DetachStream();

    // 4. magic-byte 嗅探
    let mime = if buffer.len() >= 8 && &buffer[0..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if buffer.len() >= 3 && &buffer[0..3] == b"\xff\xd8\xff" {
        "image/jpeg"
    } else if buffer.len() >= 12 && &buffer[0..4] == b"RIFF" && &buffer[8..12] == b"WEBP" {
        "image/webp"
    } else if buffer.len() >= 6 && &buffer[0..6] == b"GIF89a" {
        "image/gif"
    } else {
        "image/png"
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buffer);
    (Some(format!("data:{};base64,{}", mime, b64)), CoverStatus::Ok)
}

// ============ SMTC 熔断退避 ============
// 系统媒体服务（SMTC）无响应时（RequestAsync 永不完成），逐轮询重复调用只会
// 白白阻塞。失败后进入退避窗口，窗口内直接返回诊断信息，窗口结束自动重试。

const SMTC_BACKOFF: Duration = Duration::from_secs(5);

static SMTC_FAILED_AT: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();

fn smtc_failed_at() -> &'static Mutex<Option<std::time::Instant>> {
    SMTC_FAILED_AT.get_or_init(|| Mutex::new(None))
}

fn smtc_backoff_remaining() -> Option<Duration> {
    let guard = smtc_failed_at().lock().unwrap();
    let at = (*guard)?;
    let elapsed = at.elapsed();
    if elapsed < SMTC_BACKOFF {
        Some(SMTC_BACKOFF - elapsed)
    } else {
        None
    }
}

fn mark_smtc_failure() {
    *smtc_failed_at().lock().unwrap() = Some(std::time::Instant::now());
}

fn clear_smtc_failure() {
    *smtc_failed_at().lock().unwrap() = None;
    SMTC_FAIL_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
}

// ============ 会话管理器常驻复用 ============
// 每 500ms 轮询都调一次 RequestAsync 会持续冲击系统媒体服务（也更容易把它拖入
// 无响应状态）。这里只请求一次并长期复用管理器对象（eIsland 的常驻监控同款设计），
// 只有调用出错时才丢弃并重新请求。

static MANAGER: OnceLock<Mutex<Option<GlobalSystemMediaTransportControlsSessionManager>>> = OnceLock::new();
static SMTC_FAIL_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 连续失败达到该次数才提示"媒体服务无响应"，避免偶发慢响应误报
const SMTC_DIAG_AFTER_FAILURES: u32 = 3;

fn manager_slot() -> &'static Mutex<Option<GlobalSystemMediaTransportControlsSessionManager>> {
    MANAGER.get_or_init(|| Mutex::new(None))
}

/// 丢弃缓存的管理器（下次调用重新 RequestAsync）
fn drop_manager() {
    *manager_slot().lock().unwrap() = None;
}

/// 取（并缓存）会话管理器 —— 只在 STA 工作线程上调用。
fn acquire_manager() -> Result<GlobalSystemMediaTransportControlsSessionManager, String> {
    if let Some(m) = manager_slot().lock().unwrap().as_ref() {
        return Ok(m.clone());
    }
    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync: {}", e))?;
    // 首次/重建请求给足时间（媒体栈冷启动可能较慢），成功后长期复用
    let manager = wait_async(&op, 3000).map_err(|e| format!("manager: {}", e))?;
    *manager_slot().lock().unwrap() = Some(manager.clone());
    Ok(manager)
}

fn note_smtc_failure(info: &mut MusicInfo, msg: String) {
    mark_smtc_failure();
    let n = SMTC_FAIL_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    // 前两次静默（当作"暂无音乐"），连续失败才提示，避免偶发抖动吓人
    if n >= SMTC_DIAG_AFTER_FAILURES {
        info.diag = Some(msg);
    }
}

// ============ 会话选取（多会话兜底） ============
// 只用 GetCurrentSession() 会漏掉"会话存在但不是系统 current session"的播放器
// （网易云 cloudmusic.exe 实测如此）。策略：current 快路径（有标题或歌手就用它），
// 否则全量枚举 GetSessions()，按「正在播放 > 有标题 > 有歌手 > 第一个」挑选。

/// 会话的 SourceAppUserModelId（拿不到给占位）
fn session_app_id(session: &GlobalSystemMediaTransportControlsSession) -> String {
    session
        .SourceAppUserModelId()
        .map(|h| h.to_string())
        .unwrap_or_else(|_| "<unknown>".into())
}

fn session_is_playing(session: &GlobalSystemMediaTransportControlsSession) -> bool {
    session
        .GetPlaybackInfo()
        .ok()
        .and_then(|p| p.PlaybackStatus().ok())
        .map(playback_status_to_bool)
        .unwrap_or(false)
}

/// 读取 title/artist/有无封面（短超时）。仅用于挑选与诊断；正式采集仍走原逻辑。
fn probe_title_artist(
    session: &GlobalSystemMediaTransportControlsSession,
    timeout_ms: u64,
) -> (Option<String>, Option<String>, bool) {
    let op = match session.TryGetMediaPropertiesAsync().ok() {
        Some(op) => op,
        None => return (None, None, false),
    };
    match wait_async(&op, timeout_ms) {
        Ok(mp) => (
            mp.Title().ok().and_then(rt_to_string),
            mp.Artist().ok().and_then(rt_to_string),
            mp.Thumbnail().is_ok(),
        ),
        Err(_) => (None, None, false),
    }
}

/// 枚举全部会话（GetSessions 需要 windows 的 Foundation_Collections feature）
fn enumerate_sessions(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    diag: &mut Vec<String>,
) -> Vec<GlobalSystemMediaTransportControlsSession> {
    let mut all = Vec::new();
    match manager.GetSessions() {
        Ok(list) => {
            let n = list.Size().unwrap_or(0);
            for i in 0..n {
                if let Ok(s) = list.GetAt(i) {
                    all.push(s);
                }
            }
        }
        Err(e) => diag.push(format!("GetSessions failed: {e}")),
    }
    diag.push(format!("sessions={}", all.len()));
    all
}

/// 采集用选取：current（有标题/歌手）→ 正在播放 → 有标题 → 有歌手 → 第一个
fn select_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    diag: &mut Vec<String>,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    let current = manager.GetCurrentSession().ok();
    let all = enumerate_sessions(manager, diag);

    if let Some(cur) = current.as_ref() {
        let (t, a, img) = probe_title_artist(cur, 800);
        diag.push(format!(
            "current={}|t={}|a={}|img={}",
            session_app_id(cur),
            t.as_deref().unwrap_or("-"),
            a.as_deref().unwrap_or("-"),
            if img { 1 } else { 0 }
        ));
        if t.is_some() || a.is_some() {
            return current;
        }
        diag.push("current empty -> enumerate".into());
    } else {
        diag.push("current=none".into());
    }

    if all.is_empty() {
        return current; // 枚举不到就维持原行为
    }

    // 1) 正在播放的优先（不额外读属性，最快）
    for (i, s) in all.iter().enumerate() {
        if session_is_playing(s) {
            diag.push(format!("picked #{} via=playing", i));
            return Some(s.clone());
        }
    }

    // 2) 都不在播放 → 最多探测 3 个会话，找有标题/歌手的
    let mut first_with_artist: Option<GlobalSystemMediaTransportControlsSession> = None;
    let mut first_with_artist_idx = 0usize;
    for (i, s) in all.iter().enumerate().take(3) {
        let (t, a, img) = probe_title_artist(s, 600);
        diag.push(format!(
            "#{}({})|t={}|a={}|img={}",
            i,
            session_app_id(s),
            t.as_deref().unwrap_or("-"),
            a.as_deref().unwrap_or("-"),
            if img { 1 } else { 0 }
        ));
        if t.is_some() {
            diag.push(format!("picked #{} via=title", i));
            return Some(s.clone());
        }
        if a.is_some() && first_with_artist.is_none() {
            first_with_artist = Some(s.clone());
            first_with_artist_idx = i;
        }
    }
    if let Some(s) = first_with_artist {
        diag.push(format!("picked #{} via=artist", first_with_artist_idx));
        return Some(s);
    }
    diag.push("picked #0 via=first".into());
    Some(all[0].clone())
}

/// 播放控制 / seek 用：current → 正在播放 → 第一个（不做属性探测，保持快速）
fn select_session_for_control(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    if let Ok(cur) = manager.GetCurrentSession() {
        return Some(cur);
    }
    if let Ok(list) = manager.GetSessions() {
        let n = list.Size().unwrap_or(0);
        let mut first: Option<GlobalSystemMediaTransportControlsSession> = None;
        for i in 0..n {
            if let Ok(s) = list.GetAt(i) {
                if session_is_playing(&s) {
                    return Some(s);
                }
                if first.is_none() {
                    first = Some(s);
                }
            }
        }
        return first;
    }
    None
}

/// 诊断串拼接 + 截断（按字符切，避免切断 UTF-8）
fn truncate_diag(parts: &[String]) -> String {
    let joined = parts.join("; ");
    if joined.chars().count() <= 300 {
        joined
    } else {
        let mut s: String = joined.chars().take(297).collect();
        s.push_str("...");
        s
    }
}

// ============ 采集主函数 ============

pub fn get_music_info_blocking() -> Result<MusicInfo, String> {
    com_init_current_thread();

    let mut info = MusicInfo {
        active: false,
        timestamp: chrono_now_ms(),
        ..Default::default()
    };

    // 熔断退避：窗口内直接返回，避免每次轮询都白等
    if let Some(left) = smtc_backoff_remaining() {
        info.diag = Some(format!(
            "媒体服务无响应，{}s 后自动重试",
            left.as_secs() + 1
        ));
        return Ok(info);
    }

    let manager = match acquire_manager() {
        Ok(m) => {
            clear_smtc_failure();
            m
        }
        Err(e) => {
            drop_manager();
            note_smtc_failure(&mut info, format!("媒体服务无响应：{}", e));
            return Ok(info);
        }
    };

    // ========== 会话选取 ==========
    // current 快路径优先；current 缺失或标题/歌手皆空时全量枚举挑选
    // （网易云 cloudmusic.exe 的会话不是系统 "current session"）
    let mut diag_parts: Vec<String> = Vec::new();
    let picked = select_session(&manager, &mut diag_parts);
    info.sessions_diag = Some(truncate_diag(&diag_parts));

    let Some(session) = picked else {
        let mut last = last_music_lock().lock().unwrap();
        let had_last = last.is_some();
        *last = None;
        let mut cover = cover_cache_lock().lock().unwrap();
        *cover = None;
        let mut retry = cover_retry_lock().lock().unwrap();
        retry.clear();
        if had_last {
            increment_change_counter();
        }
        return Ok(info);
    };

    info.active = true;

    // app_name
    if let Ok(id) = session.SourceAppUserModelId() {
        info.app_name = rt_to_string(id);
    }

    // media properties
    let media_props_opt: Option<_> = (|| {
        let op = session.TryGetMediaPropertiesAsync().ok()?;
        wait_async(&op, 3000).ok()
    })();

    if let Some(media_props) = media_props_opt.as_ref() {
        if let Ok(v) = media_props.Title() { info.title = rt_to_string(v); }
        if let Ok(v) = media_props.Artist() { info.artist = rt_to_string(v); }
        if let Ok(v) = media_props.AlbumTitle() { info.album = rt_to_string(v); }
    }

    let track_key = (
        info.title.clone().unwrap_or_default(),
        info.artist.clone().unwrap_or_default(),
    );

    // ========== 封面: 缓存 + 延迟重试 ==========
    {
        let mut cache = cover_cache_lock().lock().unwrap();
        let cache_hit = cache
            .as_ref()
            .map(|(t, a, _)| t == &track_key.0 && a == &track_key.1)
            .unwrap_or(false);

        if cache_hit {
            // 同一首歌 → 直接用缓存
            if let Some((_, _, url)) = cache.as_ref() {
                info.cover_url = Some(url.clone());
                info.cover_status = Some("ok".into());
            }
        } else {
            // 换歌或首次 → 尝试读 thumbnail（带延迟重试计数）
            drop(cache);

            let mut retry = cover_retry_lock().lock().unwrap();
            let count = retry.entry(track_key.clone()).or_insert(0);
            let skip = *count > 10; // 10 次 ≈ 5s 后放弃

            if !skip {
                let (cover_result, status) = 'thumb: {
                    let props = match media_props_opt.as_ref() {
                        Some(p) => p,
                        None => break 'thumb (None, CoverStatus::OpenFailed),
                    };
                    let thumb = match props.Thumbnail().ok() {
                        Some(t) => t,
                        None => break 'thumb (None, CoverStatus::NoThumbnail),
                    };
                    let open_op = match thumb.OpenReadAsync().ok() {
                        Some(op) => op,
                        None => break 'thumb (None, CoverStatus::OpenFailed),
                    };
                    let stream = match wait_async(&open_op, 2000).ok() {
                        Some(s) => s,
                        None => break 'thumb (None, CoverStatus::OpenFailed),
                    };
                    read_thumbnail_base64(stream)
                };

                match cover_result {
                    Some(url) => {
                        info.cover_url = Some(url.clone());
                        info.cover_status = Some("ok".into());
                        let mut c = cover_cache_lock().lock().unwrap();
                        *c = Some((track_key.0.clone(), track_key.1.clone(), url));
                        retry.remove(&track_key); // 成功清零
                    }
                    None => {
                        info.cover_status = Some(status.as_str().into());
                        if status != CoverStatus::NoThumbnail {
                            *count += 1; // 可重试失败 +1
                        } else {
                            retry.remove(&track_key); // NoThumbnail = 源没发布，不需要重试
                        }
                    }
                }
            } else {
                info.cover_status = Some("no-thumbnail".into());
            }
        }
    }

    // playback status
    if let Ok(playback) = session.GetPlaybackInfo() {
        if let Ok(status) = playback.PlaybackStatus() {
            info.playing = playback_status_to_bool(status);
        }
    }

    // timeline — 五字段全读
    let mut raw_pos = 0.0_f64;
    let mut raw_dur = 0.0_f64;
    let mut timeline_valid = false;

    if let Ok(timeline) = session.GetTimelineProperties() {
        if let Ok(v) = timeline.Position() { raw_pos = timespan_to_seconds(v); }
        if let Ok(end) = timeline.EndTime() {
            if let Ok(start) = timeline.StartTime() {
                raw_dur = timespan_to_seconds(end) - timespan_to_seconds(start);
            } else {
                raw_dur = timespan_to_seconds(end);
            }
        }

        // MinSeek / MaxSeek — duration 兜底 (eIsland SmtcSessionMonitor.cs:509-513)
        if let Ok(min) = timeline.MinSeekTime() {
            info.min_seek = Some(timespan_to_seconds(min));
        }
        if let Ok(max) = timeline.MaxSeekTime() {
            info.max_seek = Some(timespan_to_seconds(max));
        }
        // 如果 EndTime-StartTime 不可信，退到 MaxSeek-MinSeek
        if raw_dur <= 0.0 {
            if let (Some(min_s), Some(max_s)) = (info.min_seek, info.max_seek) {
                let d = max_s - min_s;
                if d > 0.0 { raw_dur = d; }
            }
        }

        timeline_valid = raw_dur > 0.0 || raw_pos > 0.0;

        if let Ok(lut) = timeline.LastUpdatedTime() {
            let lut_ms = (lut.UniversalTime as i64 - 116444736000000000) / 10_000;
            info.timeline_lut = Some(lut_ms);
        }
    }

    // ========== sameTrack 兜底 ==========
    let same_track = {
        let last = last_music_lock().lock().unwrap();
        last.as_ref().map(|l| {
            l.title.as_deref() == info.title.as_deref()
                && l.artist.as_deref() == info.artist.as_deref()
        }).unwrap_or(false)
    };

    if same_track {
        let mut last = last_music_lock().lock().unwrap();
        if let Some(prev) = last.as_ref() {
            if !timeline_valid {
                info.position = prev.position;
                info.duration = prev.duration;
                if info.cover_url.is_none() {
                    info.cover_url = prev.cover_url.clone();
                }
            } else {
                info.position = raw_pos;
                info.duration = raw_dur;
            }
        }
    } else {
        info.position = raw_pos;
        info.duration = raw_dur;
    }

    // ========== 变化检测 ==========
    if info.active {
        let changed = {
            let last = last_music_lock().lock().unwrap();
            match last.as_ref() {
                None => true,
                Some(prev) => {
                    prev.title.as_deref() != info.title.as_deref()
                        || prev.artist.as_deref() != info.artist.as_deref()
                        || (prev.duration - info.duration).abs() > 0.5
                }
            }
        };
        if changed { increment_change_counter(); }

        let mut last = last_music_lock().lock().unwrap();
        *last = Some(LastMusic {
            title: info.title.clone(),
            artist: info.artist.clone(),
            position: info.position,
            duration: info.duration,
            cover_url: info.cover_url.clone(),
        });
    }

    Ok(info)
}

// ============ 播放控制 ============

pub fn control_music_blocking(action: &str) -> Result<(), String> {
    com_init_current_thread();

    let manager = acquire_manager()?;

    // current 缺失时也走枚举兜底（网易云等）
    let session = select_session_for_control(&manager)
        .ok_or_else(|| "no active session".to_string())?;

    let result_op = match action {
        "play" => session.TryPlayAsync(),
        "pause" => session.TryPauseAsync(),
        "toggle" => {
            let is_playing = session.GetPlaybackInfo().ok()
                .and_then(|p| p.PlaybackStatus().ok())
                .map(|s| playback_status_to_bool(s))
                .unwrap_or(false);
            if is_playing { session.TryPauseAsync() } else { session.TryPlayAsync() }
        }
        "stop" => session.TryStopAsync(),
        "next" => session.TrySkipNextAsync(),
        "prev" | "previous" => session.TrySkipPreviousAsync(),
        other => return Err(format!("unknown action: {}", other)),
    };

    let op = result_op.map_err(|e| format!("control op: {}", e))?;
    wait_async(&op, 5000).map_err(|e| format!("await control: {}", e))?;
    Ok(())
}

fn seek_music_blocking(position_sec: f64) -> Result<(), String> {
    com_init_current_thread();

    let manager = acquire_manager()?;

    // current 缺失时也走枚举兜底（网易云等）
    let session = select_session_for_control(&manager)
        .ok_or_else(|| "no active session".to_string())?;

    let ticks = (position_sec * 10_000_000.0) as i64;
    let op = session.TryChangePlaybackPositionAsync(ticks)
        .map_err(|e| format!("TryChangePlaybackPositionAsync: {}", e))?;
    wait_async(&op, 5000).map_err(|e| format!("await seek: {}", e))?;
    Ok(())
}

// ============ 常驻 STA 工作线程 ============
// SMTC 的 IAsyncOperation 完成回调只投递到调用线程的 STA 消息队列，因此所有
// WinRT 调用都必须跑在这条带消息泵的常驻 STA 线程上（eIsland 的 C# 同款架构）。

enum Job {
    Get(Sender<Result<MusicInfo, String>>),
    Control(String, Sender<Result<(), String>>),
    Seek(f64, Sender<Result<(), String>>),
}

static WORKER_TX: OnceLock<Sender<Job>> = OnceLock::new();

fn worker_tx() -> &'static Sender<Job> {
    WORKER_TX.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("smtc-sta".into())
            .spawn(move || sta_thread_main(rx))
            .expect("failed to spawn smtc STA thread");
        tx
    })
}

fn sta_thread_main(rx: Receiver<Job>) {
    com_init_current_thread();
    loop {
        pump_messages();
        match rx.recv_timeout(Duration::from_millis(5)) {
            Ok(Job::Get(reply)) => {
                let _ = reply.send(get_music_info_blocking());
            }
            Ok(Job::Control(action, reply)) => {
                let _ = reply.send(control_music_blocking(&action));
            }
            Ok(Job::Seek(pos, reply)) => {
                let _ = reply.send(seek_music_blocking(pos));
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

const JOB_TIMEOUT: Duration = Duration::from_secs(15);

fn send_job<T: Send + 'static>(
    job: Job,
    rx: Receiver<Result<T, String>>,
    what: &str,
) -> Result<T, String> {
    worker_tx()
        .send(job)
        .map_err(|e| format!("smtc worker send ({}): {}", what, e))?;
    rx.recv_timeout(JOB_TIMEOUT)
        .map_err(|e| format!("smtc worker recv ({}): {}", what, e))?
}

// ============ 公共 API ============

pub async fn get_music_info() -> Result<MusicInfo, String> {
    let (tx, rx) = channel::<Result<MusicInfo, String>>();
    tauri::async_runtime::spawn_blocking(move || send_job(Job::Get(tx), rx, "get_music"))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
}

pub async fn control_music(action: String) -> Result<(), String> {
    let (tx, rx) = channel::<Result<(), String>>();
    tauri::async_runtime::spawn_blocking(move || send_job(Job::Control(action, tx), rx, "control"))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// sync 版本供 lib.rs 在 spawn_blocking 中调用
pub fn seek_music(position: f64) -> Result<(), String> {
    let (tx, rx) = channel::<Result<(), String>>();
    send_job(Job::Seek(position, tx), rx, "seek")
}

// ============ helpers ============

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟测试：走与 App 完全相同的工作线程路径，打印完整 JSON 便于诊断。
    #[test]
    fn smoke_get_music_info() {
        let (tx, rx) = channel::<Result<MusicInfo, String>>();
        let info = send_job(Job::Get(tx), rx, "smoke").expect("get_music_info_blocking failed");
        let json = serde_json::to_string_pretty(&info).unwrap();
        println!("=== SMTC snapshot ===\n{}", json);
        // 不做硬断言 — 此测试用于真机诊断；无会话时 active=false 也算通过
    }

    /// 诊断探针：打印 CoInitializeEx 结果并逐秒观察 RequestAsync 状态，最长 20s。
    #[test]
    fn probe_request_async() {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        println!("CoInitializeEx(STA) -> 0x{:08X}", hr.0 as u32);

        let op = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => op,
            Err(e) => {
                println!("RequestAsync failed immediately: {}", e);
                return;
            }
        };

        let start = std::time::Instant::now();
        loop {
            pump_messages();
            match op.Status() {
                Ok(st) => {
                    println!("t={}ms status=0x{:08X}", start.elapsed().as_millis(), st.0 as u32);
                    if st == AsyncStatus::Completed {
                        match op.GetResults() {
                            Ok(m) => {
                                let cur = m.GetCurrentSession().ok();
                                let id = cur
                                    .as_ref()
                                    .and_then(|s| s.SourceAppUserModelId().ok())
                                    .map(|h| h.to_string())
                                    .unwrap_or_else(|| "<none>".into());
                                println!("MANAGER OK; current session app = {}", id);
                            }
                            Err(e) => println!("GetResults error: {}", e),
                        }
                        return;
                    }
                }
                Err(e) => {
                    println!("Status() error: {}", e);
                    return;
                }
            }
            if start.elapsed().as_millis() > 20_000 {
                println!("TIMEOUT: RequestAsync still not completed after 20s");
                return;
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
    }
}
