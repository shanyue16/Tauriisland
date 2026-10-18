/**
 * Now Playing（`Widdit/now-playing-service`，默认 `http://127.0.0.1:9863`）
 * —— 本机第三方「正在播放」服务。我们只当**客户端**（边界见 `./types.ts` 文件头）。
 *
 * 它同时提供**两种**能力，所以这个模块有两个入口，而不是硬塞进 `PlaybackSource`：
 * - `fetchLyricsFromNowPlaying(want)` —— 歌词（含**原生逐字**与翻译），供 `lyrics.ts` 的级联
 * - `fetchNowPlayingSnapshot()` —— 曲目/进度/封面，供 `useMusic` 补 SMTC 拿不到的时间轴
 *
 * ---
 * ## 契约（2026-10-11 真机取证，安装版 0.1.0 与仓库 master 逐字段一致）
 *
 * | 路由 | 返回 |
 * |---|---|
 * | `GET /api/query` | `{ player, track }` |
 * | `GET /api/query/progress` | `{ progress }` ← **毫秒** |
 * | `GET /api/lyric` | `{ source, title, author, duration, hasLyric, hasTranslatedLyric, hasKaraokeLyric, lrc, translatedLyric, karaokeLyric }` |
 *
 * **无鉴权**（不像 Folia Stage 要 Bearer token），**也没有任何控制类路由**
 * —— 所以控制仍只能走 SMTC / Stage，与既定分工一致。
 *
 * ### ⚠️ 单位不一致（同一个程序里两套）
 * - `/api/query` 的 `track.duration` 与 `player.seekbarCurrentPosition` 是 **秒**
 * - `/api/query/progress` 的 `progress` 是 **毫秒**
 *
 * 实测同刻对照：`seekbarCurrentPosition=175` vs `progress=175149`（175×1000≈175149）。
 * **混用会让进度条差 1000 倍。**
 *
 * ### ⚠️ `karaokeLyric` 是 QRC（QQ 音乐格式），不是 LRC
 * ```
 * [行起ms,行时长ms]字(绝对ms,时长ms)字(绝对ms,时长ms)…
 * [69,1992]甲(69,175)乙(244,144)丙(388,128)丁(516,72)…
 * ```
 * **字时间是绝对毫秒**，不是相对行首 —— 自证：`甲` 的 69 = 行起 69，`乙` 的 244 = 69+175。
 * 整段被 XML 包着（`<QrcInfos>…<Lyric_1 LyricContent="…"/>`），XML 声明之后才是 LRC 段头。
 *
 * **QRC 的方括号与圆括号语义与标准 LRC 恰好相反**：LRC 里方括号是时间、圆括号是内容；
 * QRC 里**方括号是行、圆括号才是字**。按 LRC 的直觉写会解析出空。
 *
 * ---
 * ## 两条硬限制（官方 README 明写，直接影响功能预期）
 *
 * **① 进度是「算出来的」，不是读出来的 → 拖动进度条它检测不到。**
 * 它靠「检测指定进程有没有在发声」判断暂停，再自行推进进度（实测 3s 内 +3.02s，节奏是对的）。
 * 只有播放/暂停能被感知。**例外**：网易云音乐、全民Ｋ歌已单独适配（探针用 UIA 读窗口的
 * `MM:SS / MM:SS`），那两个平台能实时捕捉拖动；**洛雪/浏览器/PotPlayer/Foobar/点歌机不行**。
 *
 * ⇒ **不要把这当成"接口坏了"。** 岛上的 seek 可拖性由 `isStageControlActive()` 决定，
 * 这类平台上进度条本来就不可拖，不会给出按不动的假 affordance。
 *
 * **② 它报的歌是「它按自己配置的平台抓的」，不等于系统正在播的那首。**
 * 配置在 `Settings/settings.json`（用户设的是 `platform:"lx"`）→ 与 Folia/Stage 一样
 * **必须做身份核对**才能用在岛上的当前曲目上。
 *
 * ### ⚠️ 别用 `track.url` / `track.id` 做身份
 * 实测 `platform:lx` 时 `url` 是 `https://music.youtube.com/watch?v=dQw4w9WgXcQ`、
 * `id` 是 `3399839173` —— 这两个字段**跟着匹配到的歌词源走**，不是稳定身份。
 * 只信 `title / author / duration / cover`。
 */

import { useSettings } from "../../stores/settings";
import type { LyricLine, LyricWord } from "../../types/lyrics";
import { parseSyncedLrc } from "../../utils/lrcParser";
import { isSameArtist, isSameTrack, textMentionsTrack } from "../lyricsProviders/matcher";
import type { Candidate, ProviderLyrics, WantInfo } from "../lyricsProviders/types";
import { stripNoise } from "./lyricNoise";
import { lengthCompatible, num, requestJson, str } from "./shared";
import { stageMatchesTrack } from "./stage";
import { recordNowPlayingStatus } from "./status";

const LOG = "[NowPlaying]";

// ————————————————————————————————————————————————————————————————
// 原始响应（只声明我们真正读的字段；其余一律忽略，避免把契约钉死在无关字段上）
// ————————————————————————————————————————————————————————————————

interface RawPlayer {
  hasSong?: unknown;
  isPaused?: unknown;
  seekbarCurrentPosition?: unknown;
}

interface RawTrack {
  title?: unknown;
  author?: unknown;
  album?: unknown;
  cover?: unknown;
  duration?: unknown;
}

interface RawQuery {
  player?: RawPlayer;
  track?: RawTrack;
}

interface RawLyric {
  source?: unknown;
  title?: unknown;
  author?: unknown;
  duration?: unknown;
  hasLyric?: unknown;
  hasTranslatedLyric?: unknown;
  hasKaraokeLyric?: unknown;
  lrc?: unknown;
  translatedLyric?: unknown;
  karaokeLyric?: unknown;
}

/** 秒 → 毫秒（`/api/query` 的时间字段是秒，见文件头「单位不一致」） */
function secToMs(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 1000);
}

/** 当前设置（每次调用现读，改设置不需要重建任何东西） */
function readConfig() {
  const s = useSettings.getState().settings;
  return {
    enabled: s.nowPlayingEnabled,
    // 去掉尾斜杠：设置里用户可能带、也可能不带
    base: String(s.nowPlayingBase || "").replace(/\/+$/, ""),
    timeoutMs: s.nowPlayingTimeoutMs,
    wordByWord: s.wordByWordEnabled,
    trust: s.localLyricTrust,
  };
}

// ————————————————————————————————————————————————————————————————
// 请求（真超时）
// ————————————————————————————————————————————————————————————————

type JsonResult = { kind: "ok"; json: unknown } | { kind: "error"; detail: string };

/**
 * 带**真超时**的 GET（不是 `Promise.race` 那种假超时 —— 请求会被真正 abort）。
 * 本机回环服务不该慢：没跑起来时 ECONNREFUSED 是毫秒级，界面不该为它等待。
 * 任何异常（abort / 半截 JSON / 连接被拒 / 被 ACL 挡）都归到 error。
 */
async function getJson(url: string, timeoutMs: number): Promise<JsonResult> {
  const r = await requestJson(url, timeoutMs);
  if (r.kind === "ok") return { kind: "ok", json: r.json };
  if (r.kind === "http") return { kind: "error", detail: `HTTP ${r.status}` };
  return { kind: "error", detail: r.timedOut ? `超时(${timeoutMs}ms)` : r.name };
}

// ————————————————————————————————————————————————————————————————
// QRC（逐字）解析
// ————————————————————————————————————————————————————————————————

/**
 * 一行 QRC：`[行起ms,行时长ms]` 后面跟字。
 *
 * 不解析 XML 外壳：直接按行扫，**只认「方括号里是两个数字」这种形状**，
 * 于是 `<QrcInfos>` / `<QrcHeadInfo …/>` / `[ti:…]` / `[ar:…]` / `[offset:0]`
 * 全部自然落空，不需要先剥壳（也就不会因为歌词正文里出现引号而切错）。
 * 末行尾部的 `"/>` 同理：正文只由字匹配拼出来，尾部垃圾进不来。
 */
const QRC_LINE = /\[(\d{1,7}),(\d{1,7})\](.*)$/;

/**
 * 一个字：`甲(69,175)`。
 * ⚠️ 时间是**绝对毫秒**（不是相对行首）—— 见文件头。
 */
const QRC_WORD = /([^()]*)\((\d{1,7}),(\d{1,7})\)/g;

function parseQrc(raw: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const m = QRC_LINE.exec(rawLine.trim());
    if (!m) continue;
    const lineStart = Number(m[1]);
    const lineDur = Number(m[2]);
    const body = m[3];

    const words: LyricWord[] = [];
    // 每次新建正则实例：全局标志的正则有 lastIndex 状态，复用会漏行
    const re = new RegExp(QRC_WORD.source, "g");
    let w: RegExpExecArray | null;
    while ((w = re.exec(body)) !== null) {
      const text = w[1];
      if (!text) continue; // `(2204,137)：` 这种：冒号本身是字，空文本的组跳过
      const start = Number(w[2]);
      words.push({ text, start_ms: start, end_ms: start + Number(w[3]) });
    }
    if (words.length === 0) continue;

    out.push({
      time_ms: lineStart,
      end_ms: lineStart + lineDur,
      text: words.map((x) => x.text).join(""),
      words,
    });
  }
  return out.sort((a, b) => a.time_ms - b.time_ms);
}

/**
 * 把翻译歌词（独立的一份 LRC 文本）按时间戳贴到正文行上。
 *
 * 只认**时间戳完全一致**的行：两份歌词来自同一个源（同为 QQ），实测时间戳是对齐的；
 * 做模糊匹配反而会把意思贴错行。贴不上就不贴 —— 翻译是锦上添花，不值得为它冒险。
 */
function attachTranslations(lines: LyricLine[], translatedLrc: string): void {
  if (!translatedLrc) return;
  const tr = parseSyncedLrc(translatedLrc);
  if (tr.length === 0) return;
  const byTime = new Map<number, string>();
  for (const t of tr) {
    if (t.text.trim()) byTime.set(t.time_ms, t.text.trim());
  }
  for (const line of lines) {
    const hit = byTime.get(line.time_ms);
    if (hit && hit !== line.text) line.translation = hit;
  }
}

/**
 * 从 `/api/lyric` 的响应里解析出歌词行。
 *
 * 顺序：**逐字(QRC) → 行级(LRC)**。逐字是本源最大的价值（洛雪这类平台没有别的逐字来源），
 * 所以只要开关允许就优先用它；`wordByWord` 只表示**这份时间轴是不是原生逐字**，
 * 与 `words` 存不存在无关（同 Folia 的口径）。
 */
function parseLyrics(
  raw: RawLyric,
  allowWordByWord: boolean
): { lines: LyricLine[]; wordByWord: boolean } | null {
  if (allowWordByWord && str(raw.karaokeLyric)) {
    const qrc = stripNoise(parseQrc(str(raw.karaokeLyric)));
    if (qrc.length > 0) return { lines: qrc, wordByWord: true };
    // 防御：个别平台/版本可能把行级 LRC 塞进这个字段
    const asLrc = stripNoise(parseSyncedLrc(str(raw.karaokeLyric)));
    if (asLrc.length > 0) return { lines: asLrc, wordByWord: false };
  }

  const lrc = stripNoise(parseSyncedLrc(str(raw.lrc)));
  if (lrc.length > 0) return { lines: lrc, wordByWord: false };
  return null;
}

// ————————————————————————————————————————————————————————————————
// 快照（曲目 / 进度 / 封面）
// ————————————————————————————————————————————————————————————————

export interface NowPlayingSnapshot {
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  /**
   * 当前位置（毫秒）。**是它推算出来的**，只跟播放/暂停、不跟 seek ——
   * 见文件头「硬限制 ①」。拿它当进度条的走时依据可以，别拿它当 seek 的反馈。
   */
  positionMs: number | null;
  playing: boolean;
  coverUrl: string | null;
  /** 歌词是谁给的（诊断用，如 `qq`） */
  lyricSource?: string | null;
}

/** `/api/query` + `/api/query/progress` → 快照。任何失败都返回 null（调用方静默回落 SMTC）。 */
export async function fetchNowPlayingSnapshot(): Promise<NowPlayingSnapshot | null> {
  const cfg = readConfig();
  if (!cfg.enabled) {
    recordNowPlayingStatus({ outcome: "disabled", got: null, detail: "取进度" });
    return null;
  }
  if (!cfg.base) {
    recordNowPlayingStatus({ outcome: "disabled", got: null, detail: "地址为空" });
    return null;
  }

  const q = await getJson(`${cfg.base}/api/query`, cfg.timeoutMs);
  if (q.kind === "error") {
    recordNowPlayingStatus({ outcome: "unreachable", got: null, detail: `取进度：${q.detail}` });
    return null;
  }

  const raw = (q.json ?? {}) as RawQuery;
  const player = raw.player ?? {};
  const track = raw.track ?? {};
  const hasSong = player.hasSong === true;
  const title = str(track.title).trim();
  const artist = str(track.author).trim();

  if (!hasSong || (!title && !artist)) {
    // 接口通、只是当前没有在放 —— 与「连不上」是两回事，必须分开记（否则没法排查）
    recordNowPlayingStatus({ outcome: "noSong", got: null, detail: "取进度" });
    return null;
  }

  // 进度单独一个端点，且**单位是毫秒**。它挂了不影响曲目 —— 退回 /api/query 的秒值。
  let positionMs: number | null = null;
  let positionFrom = "query(秒)";
  const p = await getJson(`${cfg.base}/api/query/progress`, cfg.timeoutMs);
  if (p.kind === "ok") {
    const v = num((p.json as { progress?: unknown } | null)?.progress);
    if (v !== null) {
      positionMs = Math.round(v);
      positionFrom = "progress(毫秒)";
    }
  }
  if (positionMs === null) positionMs = secToMs(player.seekbarCurrentPosition);

  const cover = str(track.cover).trim();
  const snap: NowPlayingSnapshot = {
    title,
    artist,
    album: str(track.album).trim(),
    durationMs: secToMs(track.duration),
    positionMs,
    playing: player.isPaused !== true,
    coverUrl: cover || null,
  };
  recordNowPlayingStatus({
    outcome: "ok",
    // 这条路径拿不到 SMTC 的曲目（调用方才有），所以 want 留空、只报它自己报的那首
    got: `${title} / ${artist}`,
    gotDurationMs: snap.durationMs ?? undefined,
    positionMs: positionMs ?? undefined,
    matched: true,
    detail: `取进度：${positionFrom}`,
  });
  return snap;
}

/**
 * 这个快照是不是「我们正在放的那首歌」—— **宽松档**。
 *
 * 与 `stage.ts` 的 `stageMatchesTrack` 是**同一条规则**（曲名或歌手任一归一化后互相包含
 * \+ 两边都报时长时相差 ≤15s），这里复用同一个函数而不是抄一份：
 * 阈值只维护一份，否则两边会各自漂移。
 *
 * 为什么进度可以用宽松档而歌词不行：猜错的代价不同。
 * 进度猜错 = 进度条偏一点（下一拍自我纠正）；误杀 = 这个功能永远不生效。
 * 歌词猜错 = 屏幕上显示别人的歌词，肉眼可见的错误 —— 所以歌词走严格门禁（见下）。
 */
export function nowPlayingMatches(
  snap: Pick<NowPlayingSnapshot, "title" | "artist" | "durationMs">,
  want: { title: string; artist: string; durationMs?: number }
): boolean {
  // `stageMatchesTrack` 的 durationMs 是非空 number（0 = 不知道，其内部会跳过时长这一项），
  // 所以这边把 null 折成 0 —— 不能让「没报时长」变成「时长不符」。
  return stageMatchesTrack({ ...snap, durationMs: snap.durationMs ?? 0 }, want);
}

// ————————————————————————————————————————————————————————————————
// 歌词（供 lyrics.ts 的级联）
// ————————————————————————————————————————————————————————————————

/** `李佳薇` / `李佳薇/张碧晨` / `李佳薇、张碧晨` / `李佳薇 feat. 张碧晨` → 歌手数组 */
function splitArtists(author: string): string[] {
  return author
    .split(/[/、,;&×·]|\sfeat\.?\s|\sft\.?\s|\sx\s/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 任一位歌手强匹配 —— **逐位两两比**，而不是把「郑浩 / 冰洁」当成一个字符串。
 *
 * **实测踩到的坑**：SMTC 报的是 `郑浩 / 冰洁`，而接口报的是 `["郑浩", "冰洁"]`。
 * 直接用 `isSameArtist` 比这两个串时，`artistScore` 走的是「父串包含子串」分支，
 * 只给 **0.8**，而门槛是 ≥0.9 → **多歌手的歌永远过不了路径 B**（真机实测丢弃）。
 * 拆成单个歌手再比就是精确相等 → 1.0。
 *
 * 复用 `isSameArtist` 而不是自己写比较：权重要只有一份。
 */
function anyArtistMatches(gotArtists: string[], wantArtist: string): boolean {
  const wants = splitArtists(wantArtist);
  if (wants.length === 0 || gotArtists.length === 0) return false;
  return gotArtists.some((a) =>
    wants.some((w) =>
      isSameArtist({ id: "nowplaying", title: "", artists: [a] }, { title: "", artist: w })
    )
  );
}

/**
 * 丢掉「标题卡」行 —— 实测它会作为**第一行歌词**出现：
 * ```
 * [0→436] 琵琶曲DJ筱轩版 - 郑浩/冰洁
 * ```
 * 它既不是零长度行（0→436 有真实时长），也不是署名行，所以 `stripNoise` 抓不到；
 * 不处理就会在岛上第一行显示歌名+歌手（Folia 那边靠 `identityCandidates` 处理同一件事）。
 *
 * 判据用 `textMentionsTrack`（**同时**提到我们的曲名与歌手）而不是解析 `" - "`：
 * 分隔符写法列不全，而「这一行同时写了这首歌的名字和歌手」几乎只可能是标题卡。
 * **要求歌手非空**才判 —— 歌手未知时曲名可能出现在真实歌词里（如同名歌名句）。
 */
function stripTitleCard(lines: LyricLine[], want: WantInfo): LyricLine[] {
  if (!want.artist) return lines;
  return lines.filter((l) => !textMentionsTrack(l.text, want));
}

/**
 * 从 Now Playing 取歌词。
 *
 * **永不抛异常**：未启用 / 服务没跑 / 超时 / 没在放 / 曲目对不上 —— 一律返回 null，
 * 由 `lyrics.ts` 静默回落到网络级联。
 *
 * 身份核对（**严格档**，与 Folia 同级 —— 因为显示别人的歌词是肉眼可见的错误）：
 * - **路径 A**：`isSameTrack`（曲名 ≥0.9 且总分 ≥70）
 * - **路径 B**：任一位歌手强匹配 **且** 歌词时间跨度与曲长相容
 * - 两条都不中但**手里根本没有身份信息** → 采用并标 `assumed`
 *   （「没有证据」不等于「反证」，这条是踩了四次误杀才定下来的）
 */
export async function fetchLyricsFromNowPlaying(want: WantInfo): Promise<ProviderLyrics | null> {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.base) {
    recordNowPlayingStatus({ outcome: "disabled", got: null, detail: "取歌词", want: label(want) });
    return null;
  }

  const y = await getJson(`${cfg.base}/api/lyric`, cfg.timeoutMs);
  if (y.kind === "error") {
    recordNowPlayingStatus({
      outcome: "unreachable",
      got: null,
      detail: `取歌词：${y.detail}`,
      want: label(want),
      wantDurationMs: want.durationMs,
    });
    return null;
  }

  const raw = (y.json ?? {}) as RawLyric;
  const source = str(raw.source).trim() || null;
  const title = str(raw.title).trim();
  const author = str(raw.author).trim();
  const durationMs = secToMs(raw.duration) ?? undefined;

  const parsed = parseLyrics(raw, cfg.wordByWord);
  if (!parsed) {
    recordNowPlayingStatus({
      outcome: "empty",
      got: title ? `${title} / ${author}` : null,
      detail: `取歌词：接口正常但没有可用歌词行（source=${source ?? "?"}）`,
      want: label(want),
      wantDurationMs: want.durationMs,
    });
    console.info(`${LOG} 接口正常但没有可用歌词行`);
    return null;
  }

  if (str(raw.translatedLyric)) attachTranslations(parsed.lines, str(raw.translatedLyric));

  // 标题卡不是歌词（实测会作为第一行出现）——身份核对通过后才有意义，但拿它判定不依赖核对结果
  parsed.lines = stripTitleCard(parsed.lines, want);
  if (parsed.lines.length === 0) {
    recordNowPlayingStatus({
      outcome: "empty",
      got: title ? `${title} / ${author}` : null,
      detail: "取歌词：过滤后没有可用歌词行",
      want: label(want),
      wantDurationMs: want.durationMs,
    });
    return null;
  }

  // 歌词覆盖的时间跨度 —— 比它自报的 duration 更可信（自报值可能是搜索候选的时长）
  const spanMs = parsed.lines[parsed.lines.length - 1]?.time_ms;

  const got: Candidate = {
    id: "nowplaying",
    title,
    artists: splitArtists(author),
    album: undefined,
    durationMs,
  };
  const gotLabel = title || author ? `${title || "?"} / ${author || "?"}` : null;

  const base = {
    want: label(want),
    wantDurationMs: want.durationMs,
    got: gotLabel,
    gotDurationMs: durationMs,
    gotSpanMs: spanMs,
    detail: `取歌词：source=${source ?? "?"}，${parsed.lines.length} 行，${
      parsed.wordByWord ? "原生逐字" : "行级"
    }`,
  };

  // ① 用户开了「完全信任本地歌词」→ 直接采用（与 Folia 同一个开关，语义一致）
  if (cfg.trust) {
    recordNowPlayingStatus({ ...base, outcome: "ok", matched: true, detail: `${base.detail}（完全信任）` });
    return { lines: parsed.lines, duration: rawDurationSec(raw) };
  }

  // ② 完全没有身份信息 → 采用但标注「无法核对」，而不是丢弃
  if (!gotLabel) {
    recordNowPlayingStatus({
      ...base,
      outcome: "assumed",
      matched: true,
      detail: `${base.detail}；接口没报曲目，无法核对`,
    });
    console.info(`${LOG} 采用（无法核对曲目）: "${want.title}"（${parsed.lines.length} 行）`);
    return { lines: parsed.lines, duration: rawDurationSec(raw) };
  }

  // ③ 路径 A：曲名高度吻合
  if (isSameTrack(got, want)) {
    recordNowPlayingStatus({ ...base, outcome: "ok", matched: true, detail: `${base.detail}（曲名吻合）` });
    console.info(`${LOG} 命中（曲名吻合）: "${want.title}"（${parsed.lines.length} 行）`);
    return { lines: parsed.lines, duration: rawDurationSec(raw) };
  }

  // ④ 路径 B：歌手强匹配 + 时长相容（曲名是自由文本，实测会与播放器报的不一致）
  if (anyArtistMatches(got.artists, want.artist) && lengthCompatible(spanMs, want.durationMs)) {
    recordNowPlayingStatus({
      ...base,
      outcome: "ok",
      matched: true,
      detail: `${base.detail}（歌手+时长吻合）`,
    });
    console.info(`${LOG} 命中（歌手+时长吻合）: "${want.title}"（${parsed.lines.length} 行）`);
    return { lines: parsed.lines, duration: rawDurationSec(raw) };
  }

  // ⑤ 明确对不上 —— 唯一该丢弃的分支
  recordNowPlayingStatus({ ...base, outcome: "mismatch", matched: false });
  console.warn(`${LOG} 曲目对不上，丢弃：接口=${gotLabel}，岛上=${label(want)}`);
  return null;
}

function label(want: WantInfo): string {
  return `${want.title} / ${want.artist}`;
}

/** `/api/lyric` 自报的时长（秒，可能没有）—— 交给级联的 `saneDuration` 再过一道闸门 */
function rawDurationSec(raw: RawLyric): number | null {
  const n = num(raw.duration);
  return n !== null && n > 0 ? n : null;
}
