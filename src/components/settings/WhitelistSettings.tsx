import { useEffect, useState } from "react";
import { useSettings } from "../../stores/settings";
import { useNameList } from "./useNameList";
import { useI18n } from "../../i18n";
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
import { BTN_STYLE, FIELD_STYLE } from "./styles";

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
  const { t } = useI18n();
  const list = settings.musicWhitelist ?? [];

  const [input, setInput] = useState("");
  const [detecting, setDetecting] = useState(false);

  const { hint, setHint, exists, addEntry, removeEntry } = useNameList({
    list,
    commit: (next) => updateSettings({ musicWhitelist: next }),
    keys: {
      empty: "settings.music.emptyInput",
      exists: "settings.music.alreadyInWhitelist",
      added: "settings.music.added",
      removed: "settings.music.removed",
    },
  });

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
      setProbeHint({ text: t("settings.music.probeFail"), tone: "warn" });
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

  /** 从当前 SMTC 会话读取播放器标识并加入白名单（用未过滤的原始数据） */
  const handleDetect = async () => {
    if (detecting) return;
    setDetecting(true);
    setHint(null);
    try {
      const m = await fetchMusic();
      const name = m.app_name?.trim();
      if (!name) {
        setHint({ text: t("settings.music.detectNone"), tone: "warn" });
        return;
      }
      if (exists(name)) {
        setHint({ text: t("settings.music.detectAlready", { name }), tone: "warn" });
        return;
      }
      updateSettings({ musicWhitelist: [...list, name] });
      setHint({ text: t("settings.music.added", { name }), tone: "ok" });
    } catch {
      setHint({ text: t("settings.music.detectFail"), tone: "warn" });
    } finally {
      setDetecting(false);
    }
  };

  const btnStyle = BTN_STYLE;

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold mb-3 opacity-90">{t("settings.music.title")}</h3>

      {/* ① 播放器白名单 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t("settings.music.whitelist")}</span>
          <span className="text-[11px] opacity-50">{t("common.countItems", { count: list.length })}</span>
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.music.whitelistHint")}
        </div>

        {list.length === 0 ? (
          <div className="text-[11px] opacity-45">{t("settings.music.whitelistEmpty")}</div>
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
                  aria-label={t("common.removeName", { name })}
                  data-tip={t("common.removeName", { name })}
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
        <span className="text-[12px] font-medium">{t("settings.music.addTitle")}</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.music.addHint")}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("settings.music.inputPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && addEntry(input)) setInput("");
            }}
            className="flex-1 text-[12px] px-3 py-1.5 rounded-md outline-none min-w-0"
            style={FIELD_STYLE}
          />
          <button
            type="button"
            onClick={() => {
              if (addEntry(input)) setInput("");
            }}
            style={btnStyle}
          >
            {t("common.add")}
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
        <span className="text-[12px] font-medium">{t("settings.music.detectTitle")}</span>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.music.detectHint")}
        </div>
        <button
          type="button"
          onClick={() => void handleDetect()}
          disabled={detecting}
          style={{ ...btnStyle, opacity: detecting ? 0.55 : 1 }}
        >
          {detecting ? t("common.reading") : t("settings.music.detect")}
        </button>
      </div>

      {/* ④ 本地歌词接口（默认 Folia 32109） */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t("settings.music.localLyric")}</span>
          <div
            className={`switch shrink-0${settings.localLyricEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ localLyricEnabled: !settings.localLyricEnabled })}
          />
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.music.localLyricHint")}
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">{t("settings.music.endpoint")}</div>
          <input
            type="text"
            value={settings.localLyricEndpoint}
            onChange={(e) => updateSettings({ localLyricEndpoint: e.target.value })}
            placeholder="http://127.0.0.1:32109/v1/lyric"
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={FIELD_STYLE}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">{t("settings.music.timeout")}</span>
          <input
            type="number"
            min={300}
            max={5000}
            step={100}
            value={timeoutDraft}
            onChange={(e) => setTimeoutDraft(e.target.value)}
            onBlur={commitTimeout}
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{ ...FIELD_STYLE, width: 88 }}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] opacity-80">{t("settings.music.wordByWord")}</div>
            <div className="text-[10px] opacity-45 leading-relaxed mt-0.5">
              {t("settings.music.wordByWordHint")}
            </div>
          </div>
          <div
            className={`switch shrink-0${settings.wordByWordEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ wordByWordEnabled: !settings.wordByWordEnabled })}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] opacity-80">{t("settings.music.trustLocal")}</div>
            <div className="text-[10px] opacity-45 leading-relaxed mt-0.5">
              {t("settings.music.trustLocalHint")}
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
          {probing ? t("common.reading") : t("settings.music.probe")}
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
              <div className="opacity-80">{t("settings.music.recent", { outcome: describeOutcome(localStatus.outcome) })}</div>
              <div className="opacity-55">
                {t("settings.music.wantPlaying", { track: localStatus.want })}
                {fmtDur(localStatus.wantDurationMs)}
              </div>
              <div className="opacity-55">
                {t("settings.music.gotPlaying", { track: localStatus.got ?? t("settings.music.gotNone") })}
                {fmtDur(localStatus.gotSpanMs)}
              </div>
              {localStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  {t("settings.music.mismatchHint")}
                </div>
              )}
              {localStatus.detail && <div className="opacity-45">{t("settings.music.detail", { detail: localStatus.detail })}</div>}
            </>
          ) : (
            <div className="opacity-45">{t("settings.music.notFetched")}</div>
          )}
        </div>
      </div>

      {/* ⑤ Now Playing（9863）—— 歌词 + 播放进度 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t("settings.music.nowPlaying")}</span>
          <div
            className={`switch shrink-0${settings.nowPlayingEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ nowPlayingEnabled: !settings.nowPlayingEnabled })}
          />
        </div>
        <div className="text-[11px] opacity-55 leading-relaxed">
          {t("settings.music.nowPlayingHint")}
        </div>
        <div
          className="text-[10px] opacity-45 leading-relaxed"
          style={{ borderLeft: "2px solid var(--island-border)", paddingLeft: 8 }}
        >
          {t("settings.music.nowPlayingNote")}
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">{t("settings.music.endpoint")}</div>
          <input
            type="text"
            value={settings.nowPlayingBase}
            onChange={(e) => updateSettings({ nowPlayingBase: e.target.value })}
            placeholder="http://127.0.0.1:9863"
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={FIELD_STYLE}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">{t("settings.music.timeout")}</span>
          <input
            type="number"
            min={300}
            max={5000}
            step={100}
            value={npTimeoutDraft}
            onChange={(e) => setNpTimeoutDraft(e.target.value)}
            onBlur={commitNpTimeout}
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{ ...FIELD_STYLE, width: 88 }}
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
                {t("settings.music.recent", { outcome: describeNowPlayingOutcome(npStatus.outcome) })}
              </div>
              {npStatus.want && (
                <div className="opacity-55">
                  {t("settings.music.wantPlaying", { track: npStatus.want })}
                  {fmtDur(npStatus.wantDurationMs)}
                </div>
              )}
              <div className="opacity-55">
                {t("settings.music.gotPlaying", { track: npStatus.got ?? t("settings.music.gotNone") })}
                {fmtDur(npStatus.gotSpanMs)}
              </div>
              {typeof npStatus.positionMs === "number" && (
                <div className="opacity-55">{t("settings.music.stageProgress", { position: fmtDur(npStatus.positionMs).trim() })}</div>
              )}
              {npStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  {t("settings.music.npMismatch")}
                </div>
              )}
              {npStatus.outcome === "noSong" && (
                <div className="opacity-45">
                  {t("settings.music.npNoSong")}
                </div>
              )}
              {npStatus.detail && <div className="opacity-45">{t("settings.music.detail", { detail: npStatus.detail })}</div>}
            </>
          ) : (
            <div className="opacity-45">
              {t("settings.music.npNotFetched")}
            </div>
          )}
        </div>
      </div>

      {/* ⑥ Stage API（Folia 32107）—— 带控制能力的本地源 */}
      <div className="rounded-lg p-4 space-y-3" style={{ background: "var(--surface-1)" }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium">{t("settings.music.stage")}</div>
            <div className="text-[11px] opacity-55 leading-relaxed mt-0.5">
              {t("settings.music.stageHint")}
            </div>
          </div>
          <div
            className={`switch shrink-0${settings.stageApiEnabled ? " active" : ""}`}
            onClick={() => updateSettings({ stageApiEnabled: !settings.stageApiEnabled })}
          />
        </div>

        <div className="space-y-1">
          <div className="text-[11px] opacity-80">{t("settings.music.token")}</div>
          <input
            type="password"
            value={settings.stageApiToken}
            onChange={(e) => updateSettings({ stageApiToken: e.target.value })}
            placeholder={t("settings.music.tokenPlaceholder")}
            className="w-full text-[12px] px-3 py-1.5 rounded-md outline-none"
            style={FIELD_STYLE}
          />
          <div className="text-[10px] opacity-45 leading-relaxed">
            {t("settings.music.tokenHint")}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] opacity-80">{t("settings.music.endpoint")}</span>
          <input
            type="text"
            value={settings.stageApiEndpoint}
            onChange={(e) => updateSettings({ stageApiEndpoint: e.target.value })}
            placeholder="http://127.0.0.1:32107"
            className="text-[12px] px-2 py-1 rounded-md outline-none"
            style={{ ...FIELD_STYLE, width: 210 }}
          />
        </div>

        {/* 最近一次结论 —— 进度不对时唯一的排查窗口 */}
        <div
          className="text-[11px] leading-relaxed pt-2 space-y-0.5"
          style={{ borderTop: "1px solid var(--island-border)" }}
        >
          {stageStatus ? (
            <>
              <div className="opacity-80">{t("settings.music.stageRecent", { outcome: describeStageOutcome(stageStatus.outcome) })}</div>
              <div className="opacity-55">
                {t("settings.music.stagePlaying", { track: stageStatus.got ?? t("settings.music.gotNone") })}
                {fmtDur(stageStatus.gotDurationMs)}
              </div>
              {stageStatus.positionMs !== undefined && (
                <div className="opacity-55">
                  {t("settings.music.stageProgress", { position: fmtDur(stageStatus.positionMs) || " 0:00" })}
                  {stageStatus.playerState ? `　${stageStatus.playerState}` : ""}
                </div>
              )}
              {stageStatus.outcome === "mismatch" && (
                <div className="opacity-45">
                  {t("settings.music.stageMismatch")}
                </div>
              )}
              {stageStatus.detail && <div className="opacity-45">{t("settings.music.detail", { detail: stageStatus.detail })}</div>}
              {/* 控制走的是哪条路 —— 按了没反应时唯一能分清原因的地方 */}
              {controlStatus && (
                <div className="opacity-45">{describeControlStatus(controlStatus)}</div>
              )}
            </>
          ) : (
            <div className="opacity-45">{t("settings.music.stageNotFetched")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
