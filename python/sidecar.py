"""
Tauriisland Python Sidecar
==========================
为灵动岛提供系统信息采集（CPU/内存/电量/网络）、音乐播放状态读取和歌词获取。
使用 Python 标准库 http.server 提供 HTTP JSON 接口。

端点：
  GET /health       — 存活检查，返回 {"status": "ok"}
  GET /system       — 返回完整系统信息（CPU/内存/电量/网络）
  GET /music        — 返回当前音乐播放状态（winsdk GlobalSystemMediaTransportControls）
  GET /lyrics?title=X&artist=Y  — 从 LRCLIB 获取同步歌词
"""

import asyncio
import base64
import json
import re
import sys
import threading
import time
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    import psutil
except ImportError:
    psutil = None

try:
    from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
    from winsdk.windows.storage.streams import DataReader
    WINSDK_AVAILABLE = True
except ImportError:
    WINSDK_AVAILABLE = False

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

HOST = "127.0.0.1"
PORT = 9999

# LRCLIB 歌词搜索缓存 (避免重复请求同一首歌)
# 结构: {key: {"lyrics": [...], "duration": float}}
_lyrics_cache = {}

# Same-track 兜底缓存 — 参考 eIsland smtcService.ts 的 sameTrack 逻辑
# 当同一首歌的 timeline 被播放器报成 0 时，保留上次采集到的有效值
_last_music = None  # 完整上一次采集结果


# ============ 系统信息 ============

def collect_system_info() -> dict:
    """采集一次系统快照。psutil 未安装时返回基础字段。"""
    info = {}

    if psutil is None:
        info["error"] = "psutil not installed"
        return info

    # CPU
    info["cpu"] = {
        "percent": psutil.cpu_percent(interval=0.2),
        "count": psutil.cpu_count(logical=True),
    }

    # 内存
    mem = psutil.virtual_memory()
    info["memory"] = {
        "percent": mem.percent,
        "used_mb": round(mem.used / (1024 * 1024)),
        "total_mb": round(mem.total / (1024 * 1024)),
    }

    # 电量（台式机无电池时返回 None）
    battery = psutil.sensors_battery()
    if battery:
        info["battery"] = {
            "percent": battery.percent,
            "charging": battery.power_plugged,
        }
    else:
        info["battery"] = None

    # 网络
    net_io = psutil.net_io_counters()
    info["network"] = {
        "sent_mb": round(net_io.bytes_sent / (1024 * 1024), 2),
        "recv_mb": round(net_io.bytes_recv / (1024 * 1024), 2),
    }

    return info


# ============ 音乐播放器状态采集 ============

def _timespan_to_seconds(ts) -> float:
    """将 winsdk TimeSpan 转为秒。"""
    if ts is None:
        return 0.0

    if hasattr(ts, "duration"):
        return ts.duration / 10_000_000.0

    if hasattr(ts, "total_seconds"):
        return ts.total_seconds()

    try:
        return float(ts)
    except (TypeError, ValueError):
        return 0.0


def _playback_status_to_bool(status) -> bool:
    """将 winsdk PlaybackStatus 枚举转为 playing bool。

    winsdk PlaybackStatus 值（int enum）：
      CLOSED=0, OPENED=1, CHANGING=2, STOPPED=3, PLAYING=4, PAUSED=5
    """
    if status is None:
        return False
    value = getattr(status, "value", status)
    return value == 4  # PLAYING


async def _thumbnail_to_data_url(thumbnail_ref) -> str | None:
    """将 winsdk thumbnail (IRandomAccessStreamReference) 转为 data URL 字符串。"""
    if thumbnail_ref is None:
        return None
    try:
        stream = await thumbnail_ref.open_read_async()
        size = stream.size
        if size == 0 or size > 5 * 1024 * 1024:  # 跳过空或超大（>5MB）
            return None
        reader = DataReader(stream)
        await reader.load_async(size)
        data = bytearray(size)
        for i in range(size):
            data[i] = reader.read_byte()

        # 判断 mime type
        mime = "image/jpeg"
        if len(data) >= 8 and bytes(data[:8]) == b'\x89PNG\r\n\x1a\n':
            mime = "image/png"
        elif len(data) >= 3 and bytes(data[:3]) == b'GIF':
            mime = "image/gif"

        b64 = base64.b64encode(bytes(data)).decode()
        return f"data:{mime};base64,{b64}"
    except Exception:
        return None


async def _collect_music_info_async() -> dict:
    """异步采集当前音乐播放状态。

    参考 eIsland smtcService.ts 的 sameTrack 兜底策略：
    当同一首歌的 timeline 被播放器报成无效值时，保留上一次采集到的有效值。
    """
    global _last_music

    result = {
        "active": False,
        "app_name": None,
        "title": None,
        "artist": None,
        "album": None,
        "cover_url": None,
        "playing": False,
        "position": 0,
        "duration": 0,
        "timeline_lut": None,
        "timestamp": int(time.time() * 1000),
    }

    if not WINSDK_AVAILABLE:
        result["error"] = "winsdk not installed"
        return result

    try:
        manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        session = manager.get_current_session()

        if session is None:
            # 没会话 → 清空 sameTrack 缓存
            _last_music = None
            return result

        result["active"] = True

        # 应用名
        try:
            result["app_name"] = session.source_app_user_model_id or None
        except Exception:
            pass

        # 媒体属性 + 封面
        try:
            info = await session.try_get_media_properties_async()
            if info:
                result["title"] = info.title or None
                result["artist"] = info.artist or None
                result["album"] = info.album_title or None
                result["cover_url"] = await _thumbnail_to_data_url(
                    getattr(info, "thumbnail", None)
                )
        except Exception:
            pass

        # 播放状态
        try:
            playback = session.get_playback_info()
            if playback:
                result["playing"] = _playback_status_to_bool(playback.playback_status)
        except Exception:
            pass

        # ========== Timeline ==========
        raw_pos = 0.0
        raw_dur = 0.0
        timeline_valid = False

        try:
            timeline = session.get_timeline_properties()
            if timeline:
                raw_pos = _timespan_to_seconds(timeline.position)
                raw_dur = _timespan_to_seconds(timeline.end_time)
                timeline_valid = raw_dur > 0 or raw_pos > 0

                # last_updated_time — 前端可用来检测拖动
                lut = timeline.last_updated_time
                if lut is not None:
                    try:
                        result["timeline_lut"] = int(lut.timestamp() * 1000)
                    except Exception:
                        pass
        except Exception:
            pass

        # ========== sameTrack 兜底 (eIsland 策略) ==========
        # 判断是否同一首歌
        same_track = False
        if _last_music and result["title"] and _last_music.get("title"):
            same_track = (
                result["title"] == _last_music["title"]
                and (result["artist"] or "") == (_last_music.get("artist") or "")
            )

        if same_track:
            prev = _last_music
            # eIsland: timeline 无效时保留 prevPayload 值
            if not timeline_valid:
                result["position"] = prev.get("position", 0)
                result["duration"] = prev.get("duration", 0)
                # 封面也保留（避免重新请求闪烁）
                if not result["cover_url"]:
                    result["cover_url"] = prev.get("cover_url")
            else:
                result["position"] = round(raw_pos, 1)
                result["duration"] = round(raw_dur, 1)
        else:
            # 换歌了
            result["position"] = round(raw_pos, 1)
            result["duration"] = round(raw_dur, 1)

        # ========== Duration fallback (LRCLIB 精确值 > 歌词推算) ==========
        if result["duration"] <= 0 and result["title"]:
            fallback_cache = None
            cache_key = f"{result['title']}||{result.get('artist') or ''}"
            if cache_key in _lyrics_cache:
                fallback_cache = _lyrics_cache[cache_key]
            else:
                for k, v in _lyrics_cache.items():
                    cached_title = k.split("||")[0]
                    if cached_title and (cached_title in result["title"] or result["title"] in cached_title):
                        fallback_cache = v
                        break
            if fallback_cache:
                if isinstance(fallback_cache, dict):
                    lrclib_dur = fallback_cache.get("duration", 0)
                    if lrclib_dur and lrclib_dur > 0:
                        result["duration"] = round(lrclib_dur, 1)
                    else:
                        lyrics_list = fallback_cache.get("lyrics", [])
                        if lyrics_list and len(lyrics_list) > 0:
                            result["duration"] = round(lyrics_list[-1]["time_ms"] / 1000.0 + 5, 1)

        # 保存本次采集结果供下次 sameTrack 兜底
        if result["active"] and result["title"]:
            _last_music = dict(result)

    except Exception as e:
        result["error"] = str(e)

    return result


def collect_music_info() -> dict:
    """同步包装：在新 event loop 中执行异步采集。"""
    try:
        return asyncio.run(_collect_music_info_async())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_collect_music_info_async())
        finally:
            loop.close()


# ============ SMTC 播放控制 ============

async def _control_async(action: str) -> dict:
    """执行 SMTC 播放控制命令。"""
    result = {"action": action, "ok": False, "error": None}

    if not WINSDK_AVAILABLE:
        result["error"] = "winsdk not installed"
        return result

    try:
        manager = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        session = manager.get_current_session()
        if session is None:
            result["error"] = "no active session"
            return result

        action_map = {
            "play": session.try_play_async,
            "pause": session.try_pause_async,
            "toggle": session.try_toggle_play_pause_async,
            "stop": session.try_stop_async,
            "next": session.try_skip_next_async,
            "prev": session.try_skip_previous_async,
        }

        fn = action_map.get(action)
        if fn is None:
            result["error"] = f"unknown action: {action}"
            return result

        # 异步调用 — 先 await 得到 IAsyncAction，再等待完成
        action_result = await fn()
        result["ok"] = True
        result["result"] = str(action_result) if action_result is not None else None
    except Exception as e:
        result["error"] = str(e)

    return result


def control_music(action: str) -> dict:
    """同步包装：执行 SMTC 播放控制。"""
    try:
        return asyncio.run(_control_async(action))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_control_async(action))
        finally:
            loop.close()


# ============ LRCLIB 歌词获取 ============

META_PREFIXES = (
    "作词", "作曲", "编曲", "制作", "混音", "母带", "录音",
    "Lyrics by", "Composed by", "Produced by", "Arranged by",
)


def parse_lrc_time(tag: str):
    """解析 LRC 时间标签为毫秒数。失败返回 None。"""
    parts = tag.split(":")
    if len(parts) != 2:
        return None
    try:
        minute = int(parts[0])
    except ValueError:
        return None
    sec_parts = parts[1].split(".")
    try:
        sec = int(sec_parts[0])
    except ValueError:
        return None
    ms = 0
    if len(sec_parts) > 1:
        frac = sec_parts[1][:3]
        try:
            val = int(frac)
        except ValueError:
            return None
        if len(frac) == 1:
            ms = val * 100
        elif len(frac) == 2:
            ms = val * 10
        else:
            ms = val
    return minute * 60000 + sec * 1000 + ms


def parse_synced_lrc(lrc_text: str) -> list:
    """解析同步 LRC 歌词文本为 [{time_ms, text}, ...] 数组。"""
    lines = []
    for raw_line in lrc_text.split("\n"):
        line = raw_line.strip()
        if not line.startswith("["):
            continue
        end_idx = line.find("]")
        if end_idx == -1:
            continue
        tag = line[1:end_idx]
        text = line[end_idx + 1:].strip()
        time_ms = parse_lrc_time(tag)
        if time_ms is None or not text:
            continue
        # 跳过元信息行
        if any(text.startswith(p) for p in META_PREFIXES):
            continue
        lines.append({"time_ms": time_ms, "text": text})
    lines.sort(key=lambda x: x["time_ms"])
    return lines


def fetch_lyrics_from_lrclib(title: str, artist: str) -> tuple[list | None, float | None]:
    """从 LRCLIB 获取同步歌词和精确时长。返回 (lyrics_lines, duration_sec)。失败返回 (None, None)。"""
    if not REQUESTS_AVAILABLE:
        return None, None

    headers = {"User-Agent": "Tauriisland/1.0 (https://github.com/user/tauriisland)"}
    timeout = 8

    def _extract_duration(item) -> float | None:
        if isinstance(item, dict):
            d = item.get("duration")
            if d is not None:
                try:
                    return float(d)
                except (TypeError, ValueError):
                    pass
        return None

    # 策略 1 & 2: /api/search 精确搜索
    for t, a in [(title, artist), (title.strip(), artist.strip())]:
        if not t:
            continue
        url = f"https://lrclib.net/api/search?track_name={urllib.parse.quote(t)}&artist_name={urllib.parse.quote(a)}"
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                items = resp.json()
                if items and isinstance(items, list):
                    for item in items:
                        synced = item.get("syncedLyrics") if isinstance(item, dict) else None
                        if synced and isinstance(synced, str) and len(synced) > 0:
                            lines = parse_synced_lrc(synced)
                            if lines:
                                return lines, _extract_duration(item)
        except Exception:
            continue

    # 策略 3: 关键词模糊搜索
    if title:
        query = f"{title} {artist}".strip()
        url = f"https://lrclib.net/api/search?q={urllib.parse.quote(query)}"
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                items = resp.json()
                if items and isinstance(items, list):
                    for item in items:
                        synced = item.get("syncedLyrics") if isinstance(item, dict) else None
                        if synced and isinstance(synced, str) and len(synced) > 0:
                            lines = parse_synced_lrc(synced)
                            if lines:
                                return lines, _extract_duration(item)
        except Exception:
            pass

    # 策略 4: /api/get 精确获取
    if title:
        url = f"https://lrclib.net/api/get?track_name={urllib.parse.quote(title)}&artist_name={urllib.parse.quote(artist or '')}"
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                item = resp.json()
                if isinstance(item, dict):
                    synced = item.get("syncedLyrics")
                    if synced and isinstance(synced, str) and len(synced) > 0:
                        lines = parse_synced_lrc(synced)
                        if lines:
                            return lines, _extract_duration(item)
                    else:
                        # 没歌词但有 duration → 也返回 duration
                        d = _extract_duration(item)
                        if d:
                            return None, d
        except Exception:
            pass

    return None, None


def get_lyrics(title: str, artist: str) -> dict:
    """获取歌词，带内存缓存。缓存结构: _lyrics_cache[key] = {"lyrics": [...], "duration": float}"""
    result = {
        "title": title,
        "artist": artist,
        "lyrics": [],
        "duration": 0,
        "found": False,
        "error": None,
    }

    if not title:
        result["error"] = "title is required"
        return result

    if not REQUESTS_AVAILABLE:
        result["error"] = "requests library not installed"
        return result

    cache_key = f"{title}||{artist}"
    cached = _lyrics_cache.get(cache_key)
    if cached:
        result["lyrics"] = cached.get("lyrics", [])
        result["duration"] = cached.get("duration", 0)
        result["found"] = len(result["lyrics"]) > 0
        return result

    lines, duration = fetch_lyrics_from_lrclib(title, artist or "")
    if lines:
        result["lyrics"] = lines
        result["found"] = True
    if duration:
        result["duration"] = duration
    _lyrics_cache[cache_key] = {"lyrics": result["lyrics"], "duration": result["duration"]}
    return result


# ============ HTTP Handler ============

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path_part, _, query_part = self.path.partition("?")
        path = path_part

        if path == "/health":
            self._send_json(200, {
                "status": "ok",
                "psutil": psutil is not None,
                "winsdk": WINSDK_AVAILABLE,
                "requests": REQUESTS_AVAILABLE,
            })
        elif path == "/system":
            self._send_json(200, collect_system_info())
        elif path == "/music":
            self._send_json(200, collect_music_info())
        elif path == "/lyrics":
            # 解析 query string 参数
            params = {}
            if query_part:
                for pair in query_part.split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[urllib.parse.unquote(k)] = urllib.parse.unquote(v)
            title = params.get("title", "").strip()
            artist = params.get("artist", "").strip()
            self._send_json(200, get_lyrics(title, artist))
        elif path == "/control":
            params = {}
            if query_part:
                for pair in query_part.split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[urllib.parse.unquote(k)] = urllib.parse.unquote(v)
            action = params.get("action", "").strip().lower()
            self._send_json(200, control_music(action))
        else:
            self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        """抑制 access log，避免刷屏。"""
        pass


def main():
    server = HTTPServer((HOST, PORT), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # 告诉父进程（Rust）服务已就绪
    print(json.dumps({
        "sidecar": "ready",
        "host": HOST,
        "port": PORT,
        "winsdk": WINSDK_AVAILABLE,
        "requests": REQUESTS_AVAILABLE,
    }), flush=True)

    try:
        thread.join()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
