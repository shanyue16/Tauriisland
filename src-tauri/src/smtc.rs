//! Windows SMTC (System Media Transport Controls) 采集模块。
//!
//! 直接调用 WinRT GlobalSystemMediaTransportControlsSessionManager。
//! 参考: eIsland SmtcSessionMonitor.cs / SmtcController.cs

use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use windows::Foundation::{AsyncActionCompletedHandler, AsyncOperationCompletedHandler, AsyncStatus, IAsyncAction};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

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

fn com_init_current_thread() {
    unsafe {
        // MTA：WinRT 异步完成回调由线程池派发，无需消息泵。
        // （STA 且无消息泵时 Status() 永远停在 Started，RequestAsync 会超时）
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// 同步等待 IAsyncOperation<T> — 注册 Completed 回调 + Condvar，带超时。
/// 回调在线程池执行（MTA），不依赖调用线程消息泵。
fn wait_async<T: windows::core::RuntimeType>(
    op: &windows::Foundation::IAsyncOperation<T>,
    timeout_ms: u64,
) -> windows::core::Result<T> {
    type Flag = (Mutex<bool>, Condvar);
    let done: Arc<Flag> = Arc::new((Mutex::new(false), Condvar::new()));
    let done_cb = done.clone();
    let handler = AsyncOperationCompletedHandler::<T>::new(move |_op, _status| {
        let (lock, cvar) = &*done_cb;
        if let Ok(mut g) = lock.lock() {
            *g = true;
            cvar.notify_all();
        }
        Ok(())
    });
    op.SetCompleted(&handler)?;

    let (lock, cvar) = &*done;
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut fired = lock.lock().unwrap();
    while !*fired {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x800705B4u32 as i32), // WAIT_TIMEOUT
                "WinRT async wait timeout",
            ));
        }
        let (g, _timeout) = cvar.wait_timeout(fired, deadline - now).unwrap();
        fired = g;
    }
    drop(fired);

    match op.Status()? {
        AsyncStatus::Completed => op.GetResults(),
        AsyncStatus::Error => {
            let hr = op.ErrorCode().unwrap_or_default();
            Err(windows::core::Error::from(hr))
        }
        _ => Err(windows::core::Error::new(
            windows::core::HRESULT(0x80004005u32 as i32), // E_FAIL
            "WinRT async did not complete",
        )),
    }
}

/// 同步等待 IAsyncAction（如 DataReader.LoadAsync）
fn wait_async_action(op: &IAsyncAction, timeout_ms: u64) -> windows::core::Result<()> {
    type Flag = (Mutex<bool>, Condvar);
    let done: Arc<Flag> = Arc::new((Mutex::new(false), Condvar::new()));
    let done_cb = done.clone();
    let handler = AsyncActionCompletedHandler::new(move |_op, _status| {
        let (lock, cvar) = &*done_cb;
        if let Ok(mut g) = lock.lock() {
            *g = true;
            cvar.notify_all();
        }
        Ok(())
    });
    op.SetCompleted(&handler)?;

    let (lock, cvar) = &*done;
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut fired = lock.lock().unwrap();
    while !*fired {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x800705B4u32 as i32),
                "WinRT async action wait timeout",
            ));
        }
        let (g, _timeout) = cvar.wait_timeout(fired, deadline - now).unwrap();
        fired = g;
    }
    drop(fired);

    match op.Status()? {
        AsyncStatus::Completed => Ok(()),
        AsyncStatus::Error => {
            let hr = op.ErrorCode().unwrap_or_default();
            Err(windows::core::Error::from(hr))
        }
        _ => Err(windows::core::Error::new(
            windows::core::HRESULT(0x80004005u32 as i32),
            "WinRT async action did not complete",
        )),
    }
}

// ============ thumbnail 读取（按规格重写） ============
// 参考 eIsland SmtcController.cs:190-212 — 8MB 上限，兼容多种流

const MAX_COVER_BYTES: usize = 8 * 1024 * 1024; // 8MB

/// 从 IRandomAccessStreamWithContentType 读封面，返回 (data_url, CoverStatus)
fn read_thumbnail_base64(
    stream: windows::Storage::Streams::IRandomAccessStreamWithContentType,
) -> (Option<String>, CoverStatus) {
    // 1. Size 检查
    let size = match stream.Size().ok() {
        Some(s) if s > 0 => s as usize,
        _ => return (None, CoverStatus::TooLarge),
    };
    if size > MAX_COVER_BYTES {
        return (None, CoverStatus::TooLarge);
    }

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

    let load_op = match reader.LoadAsync(size as u32).ok() {
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

// ============ 采集主函数 ============

pub fn get_music_info_blocking() -> Result<MusicInfo, String> {
    com_init_current_thread();

    let manager_op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync: {}", e))?;
    let manager = wait_async(&manager_op, 3000).map_err(|e| format!("manager: {}", e))?;

    let session = manager.GetCurrentSession().ok();

    let mut info = MusicInfo {
        active: false,
        timestamp: chrono_now_ms(),
        ..Default::default()
    };

    let Some(session) = session else {
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

    let manager_op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync: {}", e))?;
    let manager = wait_async(&manager_op, 3000).map_err(|e| format!("manager: {}", e))?;

    let session = manager.GetCurrentSession().ok();
    let Some(session) = session else { return Err("no active session".into()); };

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

pub fn seek_music(position_sec: f64) -> Result<(), String> {
    com_init_current_thread();

    let manager_op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("RequestAsync: {}", e))?;
    let manager = wait_async(&manager_op, 3000).map_err(|e| format!("manager: {}", e))?;

    let session = manager.GetCurrentSession().ok();
    let Some(session) = session else { return Err("no active session".into()); };

    let ticks = (position_sec * 10_000_000.0) as i64;
    let op = session.TryChangePlaybackPositionAsync(ticks)
        .map_err(|e| format!("TryChangePlaybackPositionAsync: {}", e))?;
    wait_async(&op, 5000).map_err(|e| format!("await seek: {}", e))?;
    Ok(())
}

// ============ 公共 API (spawn_blocking) ============

pub async fn get_music_info() -> Result<MusicInfo, String> {
    tauri::async_runtime::spawn_blocking(get_music_info_blocking)
        .await.map_err(|e| format!("spawn_blocking: {}", e))?
}

pub async fn control_music(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || control_music_blocking(&action))
        .await.map_err(|e| format!("spawn_blocking: {}", e))?
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

    /// 冒烟测试：直接调用阻塞采集，打印完整 JSON 便于诊断。
    #[test]
    fn smoke_get_music_info() {
        let info = get_music_info_blocking().expect("get_music_info_blocking failed");
        let json = serde_json::to_string_pretty(&info).unwrap();
        println!("=== SMTC snapshot ===\n{}", json);
        // 不做硬断言 — 此测试用于真机诊断；无会话时 active=false 也算通过
    }
}
