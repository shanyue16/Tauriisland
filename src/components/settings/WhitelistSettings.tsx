import { useState } from "react";
import { useSettings } from "../../stores/settings";
import { fetchMusic } from "../../services/music";

/**
 * 歌曲设置 - 白名单
 *
 * 参考 eIsland 的设置页：只有白名单内的播放器才会触发歌曲信息获取。
 * 匹配规则：忽略大小写 + 子串匹配（与 eIsland 一致）。
 * 白名单为空时不做任何过滤（避免清空后永远拿不到歌曲）。
 */
export default function WhitelistSettings() {
  const { settings, updateSettings } = useSettings();
  const list = settings.musicWhitelist ?? [];

  const [input, setInput] = useState("");
  const [hint, setHint] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [detecting, setDetecting] = useState(false);

  const exists = (name: string) =>
    list.some((entry) => entry.toLowerCase() === name.toLowerCase());

  /** 添加一项；返回是否成功（供输入框决定是否清空） */
  const addEntry = (raw: string): boolean => {
    const name = raw.trim();
    if (!name) {
      setHint({ text: "请输入播放器进程名", tone: "warn" });
      return false;
    }
    if (exists(name)) {
      setHint({ text: `「${name}」已在白名单中`, tone: "warn" });
      return false;
    }
    updateSettings({ musicWhitelist: [...list, name] });
    setHint({ text: `已添加 ${name}`, tone: "ok" });
    return true;
  };

  const removeEntry = (name: string) => {
    updateSettings({ musicWhitelist: list.filter((entry) => entry !== name) });
    setHint({ text: `已移除 ${name}`, tone: "ok" });
  };

  /** 从当前 SMTC 会话读取播放器标识并加入白名单（用未过滤的原始数据） */
  const handleDetect = async () => {
    if (detecting) return;
    setDetecting(true);
    setHint(null);
    try {
      const m = await fetchMusic();
      const name = m.app_name?.trim();
      if (!name) {
        setHint({ text: "未检测到正在播放的播放器", tone: "warn" });
        return;
      }
      if (exists(name)) {
        setHint({ text: `当前播放器「${name}」已在白名单中`, tone: "warn" });
        return;
      }
      updateSettings({ musicWhitelist: [...list, name] });
      setHint({ text: `已添加 ${name}`, tone: "ok" });
    } catch {
      setHint({ text: "读取播放进程失败", tone: "warn" });
    } finally {
      setDetecting(false);
    }
  };

  const btnStyle: React.CSSProperties = {
    fontSize: 11,
    lineHeight: 1,
    padding: "7px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.08)",
    color: "var(--island-text)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">歌曲设置 - 白名单</h3>

      {/* ① 播放器白名单 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">播放器白名单</span>
          <span className="text-[11px] opacity-50">{list.length} 项</span>
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          只有白名单内的播放器才会触发歌曲信息获取（忽略大小写、包含匹配）。
        </div>

        {list.length === 0 ? (
          <div className="text-[11px] opacity-45">白名单为空：当前不过滤，任何播放器都会读取。</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {list.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 text-[11px] leading-none"
                style={{
                  padding: "5px 6px 5px 9px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <span>{name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${name}`}
                  data-tip={`移除 ${name}`}
                  onClick={() => removeEntry(name)}
                  className="flex items-center justify-center cursor-pointer"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: "none",
                    background: "rgba(255,255,255,0.14)",
                    color: "var(--island-text)",
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ② 添加播放器 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <span className="text-[12px] font-medium">添加播放器</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          手动输入播放器进程名（如 Spotify.exe），或自动从当前 SMTC 会话中检测。
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入播放器进程名（如 Spotify.exe）"
            onKeyDown={(e) => {
              if (e.key === "Enter" && addEntry(input)) setInput("");
            }}
            className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none min-w-0"
            style={{
              background: "rgba(0,0,0,0.2)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--island-text)",
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (addEntry(input)) setInput("");
            }}
            style={btnStyle}
          >
            添加
          </button>
        </div>
        {hint && (
          <div
            className="text-[11px]"
            style={{ color: hint.tone === "ok" ? "#5aa9ff" : "rgba(255,255,255,0.6)" }}
          >
            {hint.text}
          </div>
        )}
      </div>

      {/* ③ 获取播放进程 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,255,255,0.05)" }}>
        <span className="text-[12px] font-medium">获取播放进程</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          从当前系统媒体会话读取正在播放的播放器标识，并加入白名单。
        </div>
        <button
          type="button"
          onClick={() => void handleDetect()}
          disabled={detecting}
          style={{ ...btnStyle, opacity: detecting ? 0.55 : 1 }}
        >
          {detecting ? "读取中…" : "获取播放进程"}
        </button>
      </div>
    </div>
  );
}
