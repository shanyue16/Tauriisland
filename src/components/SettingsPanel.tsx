import { useState, type ComponentType, type SVGProps } from "react";
import AppearanceSettings from "./settings/AppearanceSettings";
import InteractionSettings from "./settings/InteractionSettings";
import ContentSourceSettings from "./settings/ContentSourceSettings";
import WhitelistSettings from "./settings/WhitelistSettings";
import AdvancedSettings from "./settings/AdvancedSettings";
import MonitorSettings from "./settings/MonitorSettings";
import About from "./settings/About";
import {
  PaletteIcon,
  MouseIcon,
  ClipboardListIcon,
  SparklesIcon,
  WrenchIcon,
  MonitorIcon,
  InfoIcon,
} from "./Icons";
import { useSettings } from "../stores/settings";
import { THEME_PRESETS } from "../types";

type TabKey =
  | "appearance"
  | "interaction"
  | "content"
  | "whitelist"
  | "advanced"
  | "monitor"
  | "about";

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: { key: TabKey; label: string; Icon: IconType }[] = [
  { key: "appearance", label: "外观", Icon: PaletteIcon },
  { key: "interaction", label: "交互", Icon: MouseIcon },
  { key: "content", label: "内容源", Icon: ClipboardListIcon },
  { key: "whitelist", label: "歌曲", Icon: SparklesIcon },
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
      {/* 侧边栏 */}
      <div
        className="flex flex-col overflow-y-auto"
        style={{
          width: 88,
          flexShrink: 0,
          padding: "14px 8px",
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
              height: 44,
              flexShrink: 0,
              fontSize: 11,
              lineHeight: 1,
              whiteSpace: "nowrap",
              cursor: "pointer",
              border: "none",
              borderRadius: 0,
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

      {/* 右侧内容区 */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: "16px 20px" }}
      >
        {active === "appearance" && <AppearanceSettings />}
        {active === "interaction" && <InteractionSettings />}
        {active === "content" && <ContentSourceSettings />}
        {active === "whitelist" && <WhitelistSettings />}
        {active === "advanced" && <AdvancedSettings />}
        {active === "monitor" && <MonitorSettings />}
        {active === "about" && <About />}
      </div>
    </div>
  );
}
