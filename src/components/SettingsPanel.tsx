import { useState, type ComponentType, type SVGProps } from "react";
import AppearanceSettings from "./settings/AppearanceSettings";
import PositionSettings from "./settings/PositionSettings";
import InteractionSettings from "./settings/InteractionSettings";
import ContentSourceSettings from "./settings/ContentSourceSettings";
import WhitelistSettings from "./settings/WhitelistSettings";
import AdvancedSettings from "./settings/AdvancedSettings";
import MonitorSettings from "./settings/MonitorSettings";
import NotificationSettings from "./settings/NotificationSettings";
import ShortcutsSettings from "./settings/ShortcutsSettings";
import About from "./settings/About";
import {
  PaletteIcon,
  MoveIcon,
  MouseIcon,
  KeyboardIcon,
  ClipboardListIcon,
  SparklesIcon,
  WrenchIcon,
  MonitorIcon,
  BellIcon,
  InfoIcon,
} from "./Icons";
import { useSettings } from "../stores/settings";
import { useI18n } from "../i18n";
import { THEME_PRESETS } from "../types";

type TabKey =
  | "appearance"
  | "position"
  | "interaction"
  | "shortcuts"
  | "content"
  | "whitelist"
  | "notification"
  | "advanced"
  | "monitor"
  | "about";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: { key: TabKey; labelKey: string; Icon: IconType }[] = [
  { key: "appearance", labelKey: "settings.tabs.appearance", Icon: PaletteIcon },
  { key: "position", labelKey: "settings.tabs.position", Icon: MoveIcon },
  { key: "interaction", labelKey: "settings.tabs.interaction", Icon: MouseIcon },
  { key: "shortcuts", labelKey: "settings.tabs.shortcuts", Icon: KeyboardIcon },
  { key: "content", labelKey: "settings.tabs.content", Icon: ClipboardListIcon },
  { key: "whitelist", labelKey: "settings.tabs.music", Icon: SparklesIcon },
  { key: "notification", labelKey: "settings.tabs.notification", Icon: BellIcon },
  { key: "advanced", labelKey: "settings.tabs.advanced", Icon: WrenchIcon },
  { key: "monitor", labelKey: "settings.tabs.monitor", Icon: MonitorIcon },
  { key: "about", labelKey: "settings.tabs.about", Icon: InfoIcon },
];

export default function SettingsPanel() {
  const [active, setActive] = useState<TabKey>("appearance");
  const { settings } = useSettings();
  const { t, lang } = useI18n();
  const theme = THEME_PRESETS[settings.theme];
  // 侧边栏宽度随语言自适应：中文 88px 足够，英文标签更长（如 Notifications），
  // 放宽到 118px 避免 nowrap 溢出/截断，仍保证 10 项 × 25px = 250 = 可用高度。
  const sidebarW = lang === "en" ? 118 : 88;

  return (
    <div
      className="w-full h-full flex"
      style={{ color: theme.text, background: "transparent" }}
    >
      {/* 侧边栏：10 个标签全部可见（导航项被折起来是硬伤，不滚动）。
          行高 25px × 10 = 250 = 可用高度 250px（274 面板高 − 上下各 12px padding）。
          历史：8 项 30px/行（240）→ 9 项 27px（243）→ 加「快捷键」后收到 25px 才装得下，
          这样仍然全部可见，不需要滚动条。 */}
      <div
        className="flex flex-col overflow-hidden shrink-0"
        style={{
          width: sidebarW,
          padding: "12px 8px",
          background: theme.sidebarBg,
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        {TABS.map(({ key, labelKey, Icon }) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            className={`sidebar-tab flex flex-row items-center justify-start gap-1.5${
              active === key ? " active" : ""
            }`}
            style={{
              width: "100%",
              height: 25,
              flexShrink: 0,
              fontSize: 10.5,
              lineHeight: 1,
              whiteSpace: "nowrap",
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              color: theme.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              paddingLeft: 8,
            }}
          >
            <Icon
              size={14}
              style={{ display: "block", flexShrink: 0, lineHeight: 1 }}
            />
            <span style={{ lineHeight: 1 }}>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {/* 右侧内容区：分区标题由 .settings-body h3 统一成「小标题 + 发丝线」，
          八个面板不必逐个改（未分层的 CSS 规则优先于 Tailwind 的 utilities 层）。 */}
      <div
        className="flex-1 overflow-y-auto settings-body"
        style={{ padding: "16px 20px 20px" }}
      >
        {/* key 换页 + .panel-swap：分区切换时新面板从下方 4px 淡入。
            用 remount（key）而不是常驻八份，是因为八个面板里有两个在挂载时读盘。 */}
        <div key={active} className="panel-swap">
          {active === "appearance" && <AppearanceSettings />}
          {active === "position" && <PositionSettings />}
          {active === "interaction" && <InteractionSettings />}
          {active === "shortcuts" && <ShortcutsSettings />}
          {active === "content" && <ContentSourceSettings />}
          {active === "whitelist" && <WhitelistSettings />}
          {active === "notification" && <NotificationSettings />}
          {active === "advanced" && <AdvancedSettings />}
          {active === "monitor" && <MonitorSettings />}
          {active === "about" && <About />}
        </div>
      </div>
    </div>
  );
}
