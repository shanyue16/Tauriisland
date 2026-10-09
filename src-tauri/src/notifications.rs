//! Windows 系统通知读取 —— 解析 `wpndatabase.db`。
//!
//! 为什么不用官方 API：`Windows.UI.Notifications.Management.UserNotificationListener`
//! 需要在 MSIX 包清单里声明 User Notification Listener capability，本项目是未打包的
//! Tauri 应用（只有 tauri.conf.json），拿不到该能力，`RequestAccessAsync()` 必然被拒。
//! 详见 `docs/notifications-plan.md` §1.4。
//!
//! 三个实测关键点（照交接文档做会错，见 plan §1、§2）：
//! 1. 正文就在 `Notification.Payload`（BLOB 存明文 XML），不在什么 `NotificationBinding`
//!    表里 —— 该表根本不存在，真实表名是 `NotificationHandler`。
//! 2. **必须把 .db/-wal/-shm 三个文件一起复制再读**：实测 WAL(2.1MB) 比主库(1MB) 还大，
//!    只读主库会丢掉绝大多数最新通知。
//! 3. `ArrivalTime` 是 Windows FILETIME（自 1601 的 100ns 刻度），不是 Unix 时间。
//!
//! 设计：对外只暴露 `list_notifications(limit)` 一个深接口；复制库、WAL 回放、schema
//! 探测、XML 解析、实体反转义、时间换算全部藏在内部。内部纯函数单独可测（见文末 tests）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

// ── 常量 ───────────────────────────────────────────────────

/// FILETIME 纪元（1601-01-01）到 Unix 纪元（1970-01-01）的秒数差
const FILETIME_UNIX_EPOCH_DIFF: i64 = 11_644_473_600;
/// FILETIME 一秒 = 10^7 个 100ns 刻度
const FILETIME_TICKS_PER_SEC: i64 = 10_000_000;

// ── 数据模型 ────────────────────────────────────────────────

/// 一条系统通知。
///
/// 注意：**没有 `icon` 字段** —— 未打包应用取不到应用图标，空字段比取不到的字段诚实
/// （plan §3.2）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationItem {
    /// `Notification.Id`
    pub id: i64,
    /// `NotificationHandler.PrimaryId` 原文（包标识 / 文件路径 / 含 `!` 的复合串）
    pub app_id: String,
    /// 推导出的显示名（见 `friendly_name`），取不到时回退为 `app_id`
    pub app_name: String,
    /// 第 1 个非空 `<text>`
    pub title: String,
    /// 其余 `<text>` 用 `\n` 连接
    pub body: String,
    /// Unix 秒（已从 FILETIME 换算）
    pub created_at: i64,
    /// "toast"（预留：将来若放开 tile 会用到）
    pub kind: String,
}

// ── 纯函数 ─────────────────────────────────────────────────

/// Windows FILETIME（自 1601-01-01 起的 100ns 刻度）→ Unix 秒。
///
/// 实测：`134360121382373676` → `1786036538`（2026-10-09 17:35:38 +08:00）
pub fn filetime_to_unix(ticks: i64) -> i64 {
    if ticks <= 0 {
        return 0;
    }
    ticks / FILETIME_TICKS_PER_SEC - FILETIME_UNIX_EPOCH_DIFF
}

/// 反转义 XML 实体。
///
/// `&amp;` **必须最后处理**，否则 `&amp;lt;` 会被错误地二次解码成 `<`。
pub fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// 取某个标签上的属性值（支持双引号与单引号）。
fn attr_of(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let start = xml.find(&open)?;
    let after_open = xml[start..].find('>')? + start + 1;
    let attrs = &xml[start..after_open];
    let key = format!("{}=\"", attr);
    if let Some(p) = attrs.find(&key) {
        let vs = p + key.len();
        let ve = attrs[vs..].find('"')? + vs;
        return Some(decode_entities(&attrs[vs..ve]));
    }
    let key = format!("{}='", attr);
    if let Some(p) = attrs.find(&key) {
        let vs = p + key.len();
        let ve = attrs[vs..].find('\'')? + vs;
        return Some(decode_entities(&attrs[vs..ve]));
    }
    None
}

/// 从 payload XML 里提取所有 `<text>` 元素（文档顺序，含空串）。
///
/// 每个元素内部会做**换行折叠**：实测一条 `<text>` 里可以含真实 CRLF
/// （见本机 4859：Steam++ 的多行正文全在第二个 text 里）。标题/正文是单行展示，
/// 保留换行会得到一个多行"标题"、正文却为空。折叠成空格后语义正确，
/// 元素之间仍由 `parse_toast` 用 `\n` 连接，多行正文不会丢。
fn collect_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = "<text";
    let close = "</text>";
    let mut from = 0usize;
    while let Some(rel) = xml[from..].find(open) {
        let tag_start = from + rel;
        let Some(gt_rel) = xml[tag_start..].find('>') else {
            break;
        };
        let after_open = tag_start + gt_rel + 1;
        // 自闭合 `<text/>` → 空串
        if xml[tag_start..after_open].ends_with("/>") {
            out.push(String::new());
            from = after_open;
            continue;
        }
        let Some(end_rel) = xml[after_open..].find(close) else {
            break;
        };
        let end = after_open + end_rel;
        out.push(normalize_run(&xml[after_open..end]));
        from = end + close.len();
    }
    out
}

/// 单个 `<text>` 内容的规范化：反转义 → trim → 内部换行折叠为空格。
fn normalize_run(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let trimmed = decoded.trim();
    if !trimmed.contains(['\r', '\n']) {
        return trimmed.to_string();
    }
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 解析 toast payload → (title, body)。
///
/// 规则（实测边界，plan §1.2）：
/// - 第 1 个**非空** `<text>` 作标题（`<text/>` 要跳过，否则出现空标题）；
/// - 其余非空 `<text>` 合并为正文，`\n` 连接；
/// - 取不到 text 时回退到 `<toast>` 上的 `launch` 属性值，再取不到就返回空串。
///
/// "非空"按 `str::trim` 判定 —— 必须能滤掉**全角空格 U+3000**：实测 QQ 通知的
/// 第二个 text 是 `　：可以了`（U+3000 开头，作为气泡左侧缩进）。若把 U+3000
/// 当成正文内容，界面上会顶出一个空档且 `is_empty()` 判空失效。
pub fn parse_toast(payload: &str) -> (String, String) {
    let texts = collect_texts(payload);
    let non_empty: Vec<&str> = texts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if let Some((first, rest)) = non_empty.split_first() {
        return (first.to_string(), rest.join("\n"));
    }
    (attr_of(payload, "toast", "launch").unwrap_or_default(), String::new())
}

/// 推导应用显示名。
///
/// 未打包应用拿不到"应用显示名"（`AppInfo.DisplayInfo.DisplayName` 是 UWP 独占），
/// 按 plan §3.4 分级推导：
/// 1. payload 的 `<header title="...">` —— 最准（实测 Windows 安全中心就靠它）；
/// 2. 内置映射表（只放实测见过的，不猜）；
/// 3. `PrimaryId` 是文件路径 → 取 basename 去扩展名；
/// 4. 含 `!` 的复合串 → 取最后一段；
/// 5. 兜底 `PrimaryId` 原文。
pub fn friendly_name(primary_id: &str, payload: &str) -> String {
    if let Some(title) = attr_of(payload, "header", "title") {
        let t = title.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }

    if let Some(name) = builtin_app_name(primary_id) {
        return name.to_string();
    }

    // 文件路径（可能是 `D:/Program Files/Steam++/Steam++.exe` 这种正斜杠形式）
    if primary_id.contains('/') || primary_id.contains('\\') {
        let base = primary_id
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(primary_id)
            .trim();
        let stem = match base.rfind('.') {
            Some(i) if i > 0 => &base[..i],
            _ => base,
        };
        if !stem.is_empty() {
            return stem.to_string();
        }
    }

    // 形如 `MicrosoftWindows.Client.WebExperience_cw5n1h2txyewy!Widgets`
    if let Some(last) = primary_id.rsplit('!').next() {
        let last = last.trim();
        if !last.is_empty() && last != primary_id {
            return last.to_string();
        }
    }

    primary_id.trim().to_string()
}

/// 只放**实测见过**的包标识，不做"猜名字"（plan §3.4：猜错比原文更糟）。
/// 用户新增可在此追加一行，或后续进设置项。
fn builtin_app_name(primary_id: &str) -> Option<&'static str> {
    match primary_id {
        "Windows.Defender.SecurityCenter" => Some("Windows 安全中心"),
        "ByteDance.TraeCN" => Some("Trae"),
        "Microsoft.WindowsStore_8wekyb3d8bbwe!App" => Some("Microsoft Store"),
        "Microsoft.Windows.Explorer" => Some("文件资源管理器"),
        _ => None,
    }
}

// ── 数据库读取 ──────────────────────────────────────────────

/// 快照文件名的去重计数（同进程内多次读取不互相覆盖）
static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(0);

/// wpndatabase.db 所在目录
fn wpn_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Microsoft")
            .join("Windows")
            .join("Notifications"),
    )
}

/// 把 `.db` + `-wal` + `-shm` 三个文件一起复制到临时目录。
///
/// 三个都要复制：`-wal` 里有尚未 checkpoint 的最新通知（实测比主库还大），
/// `-shm` 是 WAL 索引、缺失时 SQLite 可能无法回放。返回副本的 `.db` 路径。
fn snapshot_db(src_dir: &Path) -> Result<PathBuf, String> {
    let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let dst_dir = std::env::temp_dir().join(format!(
        "tauriisland-wpn-{}-{}",
        std::process::id(),
        seq
    ));
    std::fs::create_dir_all(&dst_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let base = "wpndatabase.db";
    std::fs::copy(src_dir.join(base), dst_dir.join(base))
        .map_err(|e| format!("复制主库失败: {}", e))?;

    // wal / shm 可能不存在（刚 checkpoint 过），缺失不算错误
    for suffix in ["-wal", "-shm"] {
        let name = format!("{}{}", base, suffix);
        let _ = std::fs::copy(src_dir.join(&name), dst_dir.join(&name));
    }

    Ok(dst_dir.join(base))
}

/// 通知库的"指纹"三元组 —— 用于**廉价地**判断库有没有变。
///
/// 为什么需要它：完整读取要复制约 3.3MB（`-wal` 常比主库还大）并打开 sqlite，
/// 单次 28–177ms。高频率轮询（1~2s）不能每次都做完整读取。而取文件元数据只要
/// 一次 stat，几乎免费 —— 于是做成两级轮询：
///   1) 高频（秒级）调 `change_fingerprint()`，只 stat 三个文件；
///   2) 指纹变了才调 `list_notifications()` 做完整读取。
///
/// 组成：`-wal` 的 (字节数, 修改时间秒) + 主库的修改时间秒。
/// 新通知会追加进 `-wal`（其长度/时间必然变化），checkpoint 后主库时间变化 ——
/// 三者合起来足以覆盖"库变了"的判定。
pub fn change_fingerprint() -> (u64, u64, u64) {
    let Some(dir) = wpn_dir() else {
        return (0, 0, 0);
    };
    let stat = |name: &str| -> (u64, u64) {
        match std::fs::metadata(dir.join(name)) {
            Ok(meta) => {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                (meta.len(), mtime)
            }
            Err(_) => (0, 0),
        }
    };
    let (wal_len, wal_mtime) = stat("wpndatabase.db-wal");
    let (_, db_mtime) = stat("wpndatabase.db");
    (wal_len, wal_mtime, db_mtime)
}

/// 读一批系统通知（最新的在前）。
///
/// `limit` 为 0 时用默认 20。任何一步失败都返回 `Err(String)`，由 Tauri command
/// 转成前端可降级的错误（前端拿到错误一律显示空态，不刷屏）。
pub fn list_notifications(limit: usize) -> Result<Vec<NotificationItem>, String> {
    let limit = if limit == 0 { 20 } else { limit.min(200) };

    let dir = wpn_dir().ok_or_else(|| "找不到 LOCALAPPDATA 环境变量".to_string())?;
    if !dir.join("wpndatabase.db").exists() {
        return Err(format!("通知数据库不存在: {}", dir.display()));
    }

    let db_path = snapshot_db(&dir)?;

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("打开通知数据库失败: {}", e))?;

    // 只取 toast：`tile` 是磁贴更新（Widgets 天气等），不是通知，
    // 实测每条 11KB XML，不过滤会把列表灌满（plan §2.3）。
    let mut stmt = conn
        .prepare(
            "SELECT n.Id,
                    COALESCE(h.PrimaryId, '') AS app_id,
                    COALESCE(n.Payload, '')   AS payload,
                    COALESCE(n.ArrivalTime, 0) AS arrival
             FROM Notification n
             LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId
             WHERE n.Type = 'toast'
             ORDER BY n.ArrivalTime DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("准备查询失败: {}", e))?;

    let rows = stmt
        .query_map([limit as i64], |row| {
            let id: i64 = row.get(0)?;
            let app_id: String = row.get(1)?;
            let payload_blob: Vec<u8> = row.get(2)?;
            let arrival: i64 = row.get(3)?;
            Ok((id, app_id, payload_blob, arrival))
        })
        .map_err(|e| format!("查询失败: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        let (id, app_id, payload_blob, arrival) =
            row.map_err(|e| format!("读取行失败: {}", e))?;

        // payload 是明文 XML（实测）。非 UTF-8 时用 lossy，解析容错优先于报错。
        let payload = String::from_utf8_lossy(&payload_blob).to_string();
        let (title, body) = parse_toast(&payload);
        let app_name = friendly_name(&app_id, &payload);

        items.push(NotificationItem {
            id,
            app_id,
            app_name,
            title,
            body,
            created_at: filetime_to_unix(arrival),
            kind: "toast".to_string(),
        });
    }

    // 读完即清理副本，避免 %TEMP% 堆积
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::remove_dir_all(parent);
    }

    Ok(items)
}

// ── 测试 ───────────────────────────────────────────────────
//
// fixture 全部取自本机**真实** toast payload（2026-10-09 实测，已去掉个人可识别内容），
// 覆盖 plan §1.2 列出的三个真实边界。这些纯函数是本次唯一可离线验证的层：
// DB 访问与 UI 依赖真机，不写自动化测试。

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测：`ByteDance.TraeCN`，`ToastText02` 模板 + 带 id 的两条 text
    const TOAST_TEXT02: &str = r#"<toast>
 <visual>
  <binding template="ToastText02">
   <text id="1">任务完成 · 分析项目结构</text>
   <text id="2">分析完成。这是一个 Tauri 2 桌面应用。</text>
  </binding>
 </visual>
 <audio silent="true"/>
</toast>"#;

    /// 实测：`Windows.Defender.SecurityCenter`，`ToastGeneric` + `&amp;` 实体 + header
    const TOAST_GENERIC_HEADER: &str = r#"<toast duration="short" launch="windowsdefender://enable&amp;fw&amp;Windows Defender Firewall" activationType="protocol"><visual><binding template="ToastGeneric"><text id="1">启用 Windows 防火墙</text><text id="2">Windows 防火墙已关闭。点击或单击以启用。</text></binding></visual><actions><action activationType="system" content="关闭" arguments="dismiss"/></actions><header activationType="protocol" id="Windows_Defender_SecurityCenter_11012" title="Windows 安全中心" arguments=""/></toast>"#;

    /// 实测：`Steam++.exe`。**三个真实边界同时出现**：XML 声明 + 空 `<text/>` 开头
    /// + 唯一一个 text 里含真实 CRLF 多行正文。
    ///
    /// ⚠️ 这里的换行必须是**真实换行**（实测 payload 就是 CRLF）：多行 raw string 直接写。
    /// 写成 `\n` 会被 Rust 转义成真实换行（碰巧对），写成 `\\n` 则变成字面量反斜杠 n（错）。
    const TOAST_EMPTY_FIRST: &str = r#"<?xml version="1.0"?><toast><visual><binding template="ToastGeneric"><text/><text>检测到启动：Steam 国际服
Steam 登录用户：测试用户
Steam 客户端登录区域：CN</text></binding></visual></toast>"#;

    /// `ToastText02` 的两条 text 里含 CRLF（实测 QQ 通知就是这个形状）：
    /// 标题仍取第 1 条，第 2 条的多行内容应折成单行并归入正文。
    const TOAST_MULTILINE_BODY: &str = r#"<toast><visual><binding template="ToastText02"><text id="1">收到 1 条新消息</text><text id="2">第一行
第二行</text></binding></visual></toast>"#;

    /// 实测：真正的 QQ（NTQQ）通知 payload 全文（Id 4899，724 字节，仅头像路径做了脱敏）。
    ///
    /// 这条很关键，它同时暴露三件事：
    /// 1. 正文 `　：可以了` **在库里是完整的** —— 之前只看 body_len=19 就断言
    ///    "QQ 正文不完整"是错的，19 字节正好是全角空格+冒号+3 个汉字的 UTF-8 长度；
    /// 2. 第二个 `<text>` 以**全角空格 U+3000** 开头（气泡缩进），必须被 trim 掉；
    /// 3. `<image placement="appLogoOverride">` 带**本地绝对路径**头像 —— 与
    ///    "未打包应用取不到图标"的旧结论矛盾，是二期图标方案的依据（本期不做）。
    const TOAST_QQ_REAL: &str = r#"<toast launch="ntqq-notification://externalCommand?subcmd=openExternalWindow;peerUid=1029663940;peerUin=1029663940;peerName=校园题库-审查员;chatType=2;fuin=3096801367;windowName=MainWindow;scene=aio;" activationType="protocol">
        <visual>
            <binding template="ToastGeneric">
                <text hint-maxLines="1">校园题库-审查员</text>
                <text hint-maxLines="1">　：可以了</text>
                <image placement="appLogoOverride" hint-crop="circle" src="D:\Users\<user>\Tencent Files\avatar\group\6d\s_6d8946c7256ba5c4bbdbd37820a6ab3a"/>
            </binding>
        </visual>
        <audio silent="true"/>
    </toast>"#;

    #[test]
    fn filetime_matches_measured_value() {
        // 本机实测值，已用 .NET `DateTimeOffset.ToUnixTimeSeconds()` 独立核对：
        //   134360121382373676 → 2026-10-09 17:35:38 (+08:00) → 1791538538
        //   134359982338606628 → 2026-10-09 13:43:53 (+08:00) → 1791524633
        assert_eq!(filetime_to_unix(134_360_121_382_373_676), 1_791_538_538);
        assert_eq!(filetime_to_unix(134_359_982_338_606_628), 1_791_524_633);
        assert_eq!(filetime_to_unix(0), 0);
        assert_eq!(filetime_to_unix(-1), 0);
    }

    #[test]
    fn decodes_entities_without_double_decoding() {
        assert_eq!(decode_entities("a &amp; b"), "a & b");
        assert_eq!(decode_entities("&lt;tag&gt;"), "<tag>");
        // `&amp;lt;` 必须只解一层，得到字面量 `&lt;` 而不是 `<`
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
    }

    #[test]
    fn parses_text02_template() {
        let (title, body) = parse_toast(TOAST_TEXT02);
        assert_eq!(title, "任务完成 · 分析项目结构");
        assert_eq!(body, "分析完成。这是一个 Tauri 2 桌面应用。");
    }

    #[test]
    fn skips_empty_text_element_for_title() {
        // 第一个 <text/> 为空 → 标题必须顺延到下一个非空 text（否则出现空标题行）。
        // 该条只有一个非空 text，所以整段（换行已折成空格）都是标题。
        let (title, body) = parse_toast(TOAST_EMPTY_FIRST);
        assert!(!title.is_empty(), "空 <text/> 不能被当成标题");
        assert_eq!(
            title,
            "检测到启动：Steam 国际服 Steam 登录用户：测试用户 Steam 客户端登录区域：CN"
        );
        assert!(title.contains("Steam 客户端登录区域：CN"));
        assert_eq!(body, "", "只有一个非空 text 时没有正文");
    }

    #[test]
    fn collapses_newlines_inside_a_single_text_run() {
        // 实测 4859：一条 <text> 里含真实 CRLF。不折叠的话会得到一个多行"标题"，
        // 且它会被误当成正文之外的东西 —— 标题必须是单行。
        let (title, _) = parse_toast(TOAST_EMPTY_FIRST);
        assert!(!title.contains('\n') && !title.contains('\r'), "标题不能含换行");
        assert!(title.contains("Steam 国际服"));
    }

    #[test]
    fn keeps_title_body_split_when_body_is_multiline() {
        let (title, body) = parse_toast(TOAST_MULTILINE_BODY);
        assert_eq!(title, "收到 1 条新消息");
        // 第 2 条 text 内的 CRLF 折成空格；元素之间仍用 \n 连接
        assert_eq!(body, "第一行 第二行");
    }

    #[test]
    fn parses_real_qq_notification() {
        let (title, body) = parse_toast(TOAST_QQ_REAL);
        assert_eq!(title, "校园题库-审查员");
        // 关键：正文开头的全角空格 U+3000 必须被 trim 掉，否则界面顶出一个空档
        assert_eq!(body, "：可以了");
        assert!(!body.starts_with('　'), "全角空格不能被当成正文内容");
        assert!(!body.starts_with(' '), "半角空格也不能留");
    }

    #[test]
    fn trims_ideographic_space_and_treats_it_as_empty() {
        // 单独的 U+3000 必须被判定为"空"，否则它会顶替真正的标题
        assert_eq!(parse_toast("<toast><visual><text>　</text><text>真标题</text></visual></toast>").0, "真标题");
        // 前导/尾随全角空格也要去掉
        assert_eq!(parse_toast("<toast><visual><text>　标题　</text></visual></toast>").0, "标题");
    }

    #[test]
    fn falls_back_to_launch_when_no_text() {
        let (title, body) = parse_toast(
            r#"<toast launch="windowsdefender://enable&amp;fw"><visual><binding template="ToastGeneric"/></visual></toast>"#,
        );
        assert_eq!(title, "windowsdefender://enable&fw");
        assert_eq!(body, "");
    }

    #[test]
    fn survives_malformed_payload() {
        assert_eq!(parse_toast(""), (String::new(), String::new()));
        assert_eq!(parse_toast("not xml at all"), (String::new(), String::new()));
        // 未闭合标签不能 panic
        let _ = parse_toast("<toast><visual><text>abc");
    }

    #[test]
    fn header_title_wins_over_primary_id() {
        // 实测：PrimaryId 是 `Windows.Defender.SecurityCenter`，但界面要显示中文名
        assert_eq!(
            friendly_name("Windows.Defender.SecurityCenter", TOAST_GENERIC_HEADER),
            "Windows 安全中心"
        );
    }

    #[test]
    fn builtin_map_covers_measured_ids() {
        assert_eq!(friendly_name("ByteDance.TraeCN", ""), "Trae");
    }

    #[test]
    fn extracts_basename_from_executable_path() {
        // 实测：PrimaryId 直接是完整文件路径（正斜杠形式）
        assert_eq!(
            friendly_name("D:/Program Files/Steam++/Steam++.exe", ""),
            "Steam++"
        );
        assert_eq!(friendly_name(r"C:\App\foo.exe", ""), "foo");
    }

    #[test]
    fn strips_yapping_suffix_after_bang() {
        assert_eq!(
            friendly_name("MicrosoftWindows.Client.WebExperience_cw5n1h2txyewy!Widgets", ""),
            "Widgets"
        );
    }

    #[test]
    fn falls_back_to_raw_primary_id() {
        // 没有映射、不是路径、没有 `!` → 原文返回（不猜，plan §3.4）
        assert_eq!(friendly_name("Some.Unknown.Package", ""), "Some.Unknown.Package");
        assert_eq!(friendly_name("", ""), "");
    }

    /// 真机冒烟：打印本机真实通知条数与耗时。
    ///
    /// DSH 沙箱内进程是 Low Mandatory Level，本测试**可能取不到数据**（表现为
    /// 条数 0 或 Err）；真机验证由用户在其桌面环境跑。用 `--nocapture` 看输出。
    #[test]
    fn smoke_list_notifications() {
        let t0 = std::time::Instant::now();
        let fp = change_fingerprint();
        let result = list_notifications(20);
        let elapsed = t0.elapsed();

        println!("--- smoke_list_notifications ---");
        println!("change_fingerprint = {:?}", fp);
        println!("elapsed            = {:?}", elapsed);
        match result {
            Ok(items) => {
                println!("count           = {}", items.len());
                for it in &items {
                    println!(
                        "  [{}] app={:?} id={:?} title={:?} body_len={} ts={}",
                        it.id,
                        it.app_name,
                        it.app_id,
                        it.title,
                        it.body.len(),
                        it.created_at
                    );
                }
            }
            Err(e) => println!("error           = {}", e),
        }
        println!("--------------------------------");
    }
}
