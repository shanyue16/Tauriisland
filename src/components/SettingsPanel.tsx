import { useState, type ComponentType, type SVGProps } from "react";
import AppearanceSettings from "./settings/AppearanceSettings";
import InteractionSettings from "./settings/InteractionSettings";
import ContentSourceSettings from "./settings/ContentSourceSettings";
import WhitelistSettings from "./settings/WhitelistSettings";
import AdvancedSettings from "./settings/AdvancedSettings";
import MonitorSettings from "./settings/MonitorSettings";
import NotificationSettings from "./settings/NotificationSettings";
import About from "./settings/About";
import {
  PaletteIcon,
  MouseIcon,
  ClipboardListIcon,
  SparklesIcon,
  WrenchIcon,
  MonitorIcon,
  BellIcon,
  InfoIcon,
} from "./Icons";
import { useSettings } from "../stores/settings";
import { THEME_PRESETS } from "../types";

type TabKey =
  | "appearance"
  | "interaction"
  | "content"
  | "whitelist"
  | "notification"
  | "advanced"
  | "monitor"
  | "about";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: { key: TabKey; label: string; Icon: IconType }[] = [
  { key: "appearance", label: "外观", Icon: PaletteIcon },
  { key: "interaction", label: "交互", Icon: MouseIcon },
  { key: "content", label: "内容源", Icon: ClipboardListIcon },
  { key: "whitelist", label: "歌曲", Icon: SparklesIcon },
  { key: "notification", label: "通知", Icon: BellIcon },
  { key: "advanced", label: "高级", Icon: WrenchIcon },
  { key: "monitor", label: "显示器", Icon: MonitorIcon },
  { key: "about", label: "关于", Icon: InfoIcon },
];

export default function SettingsPanel() {
  const [active, setActive] = useState<TabKey>("appearance");
  const { settings } = useSettings();
  const theme = THEME_PRESETS[settings.theme];

  return (
    <div
      className="w-full h-full flex"
      style={{ color: theme.text, background: "transparent" }}
    >
      {/* 侧边栏：8 个标签全部可见。
          原来每行 44px（8×44 = 352px）远超 274px 的面板高度，后四个标签
          （通知/高级/显示器/关于）必须滚动才能看到——导航项被折起来是硬伤。
          行高收到 30px + 容器上下各 12px = 264px，装得下，滚动条随之消失。 */}
      <div
        className="flex flex-col overflow-hidden shrink-0"
        style={{
          width: 88,
          padding: "12px 8px",
          background: theme.sidebarBg,
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            className={`sidebar-tab flex flex-row items-center justify-center gap-1.5${
              active === key ? " active" : ""
            }`}
            style={{
              width: "100%",
              height: 30,
              flexShrink: 0,
              fontSize: 10.5,
              lineHeight: 1,
              whiteSpace: "nowrap",
              cursor: "pointer",
              border: "none",
              borderRadius: 7,
              color: theme.text,
            }}
          >
            <Icon
              size={14}
              style={{ display: "block", flexShrink: 0, lineHeight: 1 }}
            />
            <span style={{ lineHeight: 1 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* 右侧内容区：分区标题由 .settings-body h3 统一成「小标题 + 发丝线」，
          八个面板不必逐个改（未分层的 CSS 规则优先于 Tailwind 的 utilities 层）。 */}
      <div
        className="flex-1 overflow-y-auto settings-body"
        style={{ padding: "16px 20px 20px" }}
      >
        {active === "appearance" && <AppearanceSettings />}
        {active === "interaction" && <InteractionSettings />}
        {active === "content" && <ContentSourceSettings />}
        {active === "whitelist" && <WhitelistSettings />}
        {active === "notification" && <NotificationSettings />}
        {active === "advanced" && <AdvancedSettings />}
        {active === "monitor" && <MonitorSettings />}
        {active === "about" && <About />}
      </div>
    </div>
  );
}
