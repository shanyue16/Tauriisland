import { useEffect, useState } from "react";
import { useSettings } from "../../stores/settings";
import { fetchMusic } from "../../services/music";
import { probeLocalLyric } from "../../services/playbackSources/folia";
import {
  describeControlStatus,
  describeNowPlayingOutcome,
  describeOutcome,
  describeStageOutcome,
  getControlStatus,
  getLocalLyricStatus,
  getNowPlayingStatus,
  getStageStatus,
  type ControlStatus,
  type LocalLyricStatus,
  type NowPlayingStatus,
  type StageStatus,
} from "../../services/playbackSources/status";

/**
 * 歌曲设置 - 白名单
 *
 * 参考 eIsland 的设置页：只有白名单内的播放器才会触发歌曲信息获取。
 * 匹配规则：忽略大小写 + 子串匹配（与 eIsland 一致）。
 * 白名单为空时不做任何过滤（避免清空后永远拿不到歌曲）。
 */
/**
 * 毫秒 → ` m:ss`（前面留一个全角空格，直接拼在曲名后）。
 * 同曲时两边时长应当接近 —— 这是判断「同一首歌的不同叫法」还是「放的不是同一首」的关键依据。
 */
function fmtDur(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  return `　${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function WhitelistSettings() {
  const { settings, updateSettings } = useSettings();
  const list = settings.musicWhitelist ?? [];

  const [input, setInput] = useState("");
  const [hint, setHint] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [detecting, setDetecting] = useState(false);

  // —— 本地歌词接口 ——
  // 该链路「失败一律静默」（设计如此），所以这里把最近一次尝试的结论显示出来，
  // 否则「没拿到逐字歌词」完全没法排查。
  const [localStatus, setLocalStatus] = useState<LocalLyricStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeHint, setProbeHint] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  // 超时用草稿态：直接在 onChange 里 clamp 会让"输入 5 → 300"没法打字
  const [timeoutDraft, setTimeoutDraft] = useState(String(settings.localLyricTimeoutMs));
  useEffect(() => {
    setLocalStatus(getLocalLyricStatus());
    const t = window.setInterval(() => setLocalStatus(getLocalLyricStatus()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // —— Stage API（Folia 32107）——
  // 它是唯一能给出「播放进度」的本地源，但采纳与否取决于曲目能否对上，
  // 所以这里把「取到的是哪首 / 有没有采纳」也显示出来 —— 否则进度不对时无从判断。
  const [stageStatus, setStageStatus] = useState<StageStatus | null>(null);
  const [controlStatus, setControlStatus] = useState<ControlStatus | null>(null);
  // —— Now Playing（9863）——
  // 它同时给歌词与进度，但**进度是推算值**：只跟播放/暂停、不跟 seek
  // （2026-10-11 真机实测：40s / 78 次采样，拖动进度条期间零跳变）。
  const [npStatus, setNpStatus] = useState<NowPlayingStatus | null>(null);
  const [npTimeoutDraft, setNpTimeoutDraft] = useState(String(settings.nowPlayingTimeoutMs));
  useEffect(() => {
    const sync = () => {
      setStageStatus(getStageStatus());
      setControlStatus(getControlStatus());
      setNpStatus(getNowPlayingStatus());
    };
    sync();
    const t = window.setInterval(sync, 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    setTimeoutDraft(String(settings.localLyricTimeoutMs));
  }, [settings.localLyricTimeoutMs]);
  useEffect(() => {
    setNpTimeoutDraft(String(settings.nowPlayingTimeoutMs));
  }, [settings.nowPlayingTimeoutMs]);

  const handleProbe = async () => {
    if (probing) return;
    setProbing(true);
    setProbeHint(null);
    try {
      const r = await probeLocalLyric();
      setProbeHint({ text: r.detail, tone: r.ok ? "ok" : "warn" });
    } catch {
      setProbeHint({ text: "检测失败", tone: "warn" });
    } finally {
      setProbing(false);
    }
  };

  const commitTimeout = () => {
    const v = Number(timeoutDraft);
    const clamped = Number.isFinite(v)
      ? Math.min(5000, Math.max(300, Math.round(v)))
      : settings.localLyricTimeoutMs;
    updateSettings({ localLyricTimeoutMs: clamped });
    setTimeoutDraft(String(clamped));
  };

  const commitNpTimeout = () => {
    const v = Number(npTimeoutDraft);
    const clamped = Number.isFinite(v)
      ? Math.min(5000, Math.max(300, Math.round(v)))
      : settings.nowPlayingTimeoutMs;
    updateSettings({ nowPlayingTimeoutMs: clamped });
    setNpTimeoutDraft(String(clamped));
  };

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
    border: "1px solid var(--island-border)",
    background: "var(--surface-2)",
    color: "var(--island-text)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">歌曲设置 - 白名单</h3>

      {/* ① 播放器白名单 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
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
                  background: "var(--surface-2)",
                  border: "1px solid var(--island-border)",
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
                    background: "var(--surface-3)",
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
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
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
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
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
            style={{ color: hint.tone === "ok" ? "var(--state-info)" : "var(--island-text-muted)" }}
          >
            {hint.text}
          </div>
        )}
      </div>

      {/* ③ 获取播放进程 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
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

      {/* ④ 本地歌词接口（默认 Folia 32109） */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">本地歌词接口</span>
          <div
            className={`switch shrink-0${settings.localLyricEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ localLyricEnabled: !settings.localLyricEnabled })}
          />
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          从本机第三方程序取歌词（默认 Folia 的 32109 接口）。它是唯一能给出逐字歌词的来源；
          没开、或它放的不是同一首歌时会静默回落到网络源，不影响现有歌词。
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">接口地址</div>
          <input
            type="text"
            value={settings.localLyricEndpoint}
            onChange={(e) => updateSettings({ localLyricEndpoint: e.target.value })}
            placeholder="http://127.0.0.1:32109/v1/lyric"
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={{
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">请求超时（ms）</span>
          <input
            type="number"
            min={300}
            max={5000}
            step={100}
            value={timeoutDraft}
            onChange={(e) => setTimeoutDraft(e.target.value)}
            onBlur={commitTimeout}
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{
              width: 88,
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] opacity-80">逐字高亮</div>
            <div className="text-[10px] opacity-45 leading-relaxed mt-0.5">
              关掉则只按行高亮（数据仍会取，只是不用逐字时间轴）
            </div>
          </div>
          <div
            className={`switch shrink-0${settings.wordByWordEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ wordByWordEnabled: !settings.wordByWordEnabled })}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] opacity-80">完全信任本地歌词</div>
            <div className="text-[10px] opacity-45 leading-relaxed mt-0.5">
              接口只要返回歌词就直接用，不核对曲目。适用于把 Folia 当作歌词显示、
              里面放的一定是你在听的那首的情况。默认关闭时仍然核对，
              但歌词文件里没有可解析的曲目信息时会直接采用（不误杀）。
            </div>
          </div>
          <div
            className={`switch shrink-0${settings.localLyricTrust ? " active" : ""}`}
            onClick={() => updateSettings({ localLyricTrust: !settings.localLyricTrust })}
          />
        </div>

        <button
          type="button"
          onClick={() => void handleProbe()}
          disabled={probing}
          style={{ ...btnStyle, opacity: probing ? 0.55 : 1 }}
        >
          {probing ? "检测中…" : "检测接口"}
        </button>
        {probeHint && (
          <div
            className="text-[11px] leading-relaxed"
            style={{
              color: probeHint.tone === "ok" ? "var(--state-info)" : "var(--island-text-muted)",
            }}
          >
            {probeHint.text}
          </div>
        )}

        {/* 最近一次取数结论 —— 这条链路失败是静默的，这里是唯一的排查窗口 */}
        <div
          className="text-[11px] leading-relaxed pt-2 space-y-0.5"
          style={{ borderTop: "1px solid var(--island-border)" }}
        >
          {localStatus ? (
            <>
              <div className="opacity-80">最近一次：{describeOutcome(localStatus.outcome)}</div>
              <div className="opacity-55">
                岛上在放：{localStatus.want}
                {fmtDur(localStatus.wantDurationMs)}
              </div>
              <div className="opacity-55">
                接口在放：{localStatus.got ?? "（读不到）"}
                {fmtDur(localStatus.gotSpanMs)}
              </div>
              {localStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  两个曲名不一样，所以整份被丢弃了（宁可不显示，也不显示别人的歌词）。
                  两边时长接近＝多半是同一首歌的不同叫法；差得多＝播放器和 Folia 放的不是同一首。
                </div>
              )}
              {localStatus.detail && <div className="opacity-45">说明：{localStatus.detail}</div>}
            </>
          ) : (
            <div className="opacity-45">还没有取过数（换一首歌，或点上面的「检测接口」）</div>
          )}
        </div>
      </div>

      {/* ⑤ Now Playing（9863）—— 歌词 + 播放进度 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">Now Playing（9863）</span>
          <div
            className={`switch shrink-0${settings.nowPlayingEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ nowPlayingEnabled: !settings.nowPlayingEnabled })}
          />
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          本机第三方程序 Now Playing 的接口。它同时给歌词（含逐字与翻译）与播放进度，
          歌词排在本地歌词接口之后、网络源之前；它自己已经挑好了匹配度最高的那份歌词。
          没装或没开时会静默回落，不影响现有行为。
        </div>
        <div
          className="text-[10px] opacity-45 leading-relaxed"
          style={{ borderLeft: "2px solid var(--island-border)", paddingLeft: 8 }}
        >
          注意：它的进度是按播放时钟推算的，只跟播放/暂停，不跟拖动进度条
          （网易云与全民K歌除外）。所以在别的播放器上拖了进度条，这里的进度会一直偏着，
          直到暂停/切歌才可能重新对上。
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">接口地址</div>
          <input
            type="text"
            value={settings.nowPlayingBase}
            onChange={(e) => updateSettings({ nowPlayingBase: e.target.value })}
            placeholder="http://127.0.0.1:9863"
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={{
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">请求超时（ms）</span>
          <input
            type="number"
            min={300}
            max={5000}
            step={100}
            value={npTimeoutDraft}
            onChange={(e) => setNpTimeoutDraft(e.target.value)}
            onBlur={commitNpTimeout}
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{
              width: 88,
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
        </div>

        {/* 最近一次取数结论 —— 同样是静默降级链路，这里是唯一的排查窗口 */}
        <div
          className="text-[11px] leading-relaxed pt-2 space-y-0.5"
          style={{ borderTop: "1px solid var(--island-border)" }}
        >
          {npStatus ? (
            <>
              <div className="opacity-80">
                最近一次：{describeNowPlayingOutcome(npStatus.outcome)}
              </div>
              {npStatus.want && (
                <div className="opacity-55">
                  岛上在放：{npStatus.want}
                  {fmtDur(npStatus.wantDurationMs)}
                </div>
              )}
              <div className="opacity-55">
                接口在放：{npStatus.got ?? "（读不到）"}
                {fmtDur(npStatus.gotSpanMs)}
              </div>
              {typeof npStatus.positionMs === "number" && (
                <div className="opacity-55">它的进度：{fmtDur(npStatus.positionMs).trim()}</div>
              )}
              {npStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  它报的是另一首歌，所以整份被丢弃了（宁可不显示，也不显示别人的歌词）。
                </div>
              )}
              {npStatus.outcome === "noSong" && (
                <div className="opacity-45">
                  服务在跑、但当前没有在放的东西 —— 检查 Now Playing 里选的平台对不对。
                </div>
              )}
              {npStatus.detail && <div className="opacity-45">说明：{npStatus.detail}</div>}
            </>
          ) : (
            <div className="opacity-45">
              还没有取过数（换一首歌，或确认 Now Playing 已启动、并已选对平台）
            </div>
          )}
        </div>
      </div>

      {/* ⑥ Stage API（Folia 32107）—— 带控制能力的本地源 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium">Stage API（播放进度）</div>
            <div className="text-[11px] opacity-55 leading-relaxed mt-0.5">
              从 Folia 的 32107 接口取真实播放进度与时长。它是唯一能给进度的本地源
              （酷狗在系统媒体接口侧不上报时间线，那种情况下进度只能靠本地时钟外推）。
              需要先在 Folia 里开启 Stage Mode 并复制 token，否则一律 401。
              进度只在与系统媒体接口的曲目核对通过后采纳；对不上时完全不影响现有行为。
            </div>
          </div>
          <div
            className={`switch shrink-0${settings.stageApiEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ stageApiEnabled: !settings.stageApiEnabled })}
          />
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">Token</div>
          <input
            type="password"
            value={settings.stageApiToken}
            onChange={(e) => updateSettings({ stageApiToken: e.target.value })}
            placeholder="在 Folia 的 Stage Mode 里复制"
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={{
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
          <div className="text-[10px] opacity-45 leading-relaxed">
            只保存在本机设置里，不会进仓库。Folia 里重新生成 token 后要回来更新。
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">接口地址</span>
          <input
            type="text"
            value={settings.stageApiEndpoint}
            onChange={(e) => updateSettings({ stageApiEndpoint: e.target.value })}
            placeholder="http://127.0.0.1:32107"
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{
              width: 210,
              background: "var(--input-bg)",
              border: "1px solid var(--island-border)",
              color: "var(--island-text)",
            }}
          />
        </div>

        {/* 最近一次结论 —— 进度不对时唯一的排查窗口 */}
        <div
          className="text-[11px] leading-relaxed pt-2 space-y-0.5"
          style={{ borderTop: "1px solid var(--island-border)" }}
        >
          {stageStatus ? (
            <>
              <div className="opacity-80">最近一次：{describeStageOutcome(stageStatus.outcome)}</div>
              <div className="opacity-55">
                Stage 在放：{stageStatus.got ?? "（读不到）"}
                {fmtDur(stageStatus.gotDurationMs)}
              </div>
              {stageStatus.positionMs !== undefined && (
                <div className="opacity-55">
                  进度：{fmtDur(stageStatus.positionMs) || " 0:00"}
                  {stageStatus.playerState ? `　${stageStatus.playerState}` : ""}
                </div>
              )}
              {stageStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  两边的曲目对不上，所以没有采用这个进度（播放器和 Folia 放的不是同一首）。
                </div>
              )}
              {stageStatus.detail && <div className="opacity-45">说明：{stageStatus.detail}</div>}
              {/* 控制走的是哪条路 —— 按了没反应时唯一能分清原因的地方 */}
              {controlStatus && (
                <div className="opacity-45">{describeControlStatus(controlStatus)}</div>
              )}
            </>
          ) : (
            <div className="opacity-45">还没有取过数（开启并填好 token，播一首歌看看）</div>
          )}
        </div>
      </div>
    </div>
  );
}
