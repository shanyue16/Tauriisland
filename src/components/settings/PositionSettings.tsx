import { useSettings } from "../../stores/settings";
import type { IslandStyle, HorizontalPosition } from "../../types";
import { THEME_PRESETS } from "../../types";

/**
 * 岛的位置 —— 从「外观」里单拎出来独立成一个侧边栏页。
 *
 * 这里放的都是"岛摆在桌面哪儿"的设定：形态（悬浮胶囊 / 贴边挂角）、水平基准位置，
 * 以及在基准之上的左右/上下微调。外观页保留与位置无关的项（主题、圆角、透明度、宽度）。
 */

const STYLES: { key: IslandStyle; label: string; hint: string }[] = [
  { key: "floating", label: "悬浮胶囊", hint: "四角全圆，离屏幕顶边有间距" },
  { key: "docked", label: "贴边挂角", hint: "顶部直角，紧贴屏幕顶边" },
];

const POSITIONS: { key: HorizontalPosition; label: string }[] = [
  { key: "left", label: "靠左" },
  { key: "center", label: "居中" },
  { key: "right", label: "靠右" },
];

export default function PositionSettings() {
  const { settings, updateSettings } = useSettings();
  const theme = THEME_PRESETS[settings.theme];
  const docked = settings.style === "docked";

  /** 把位置相关的三项一起复位（形态不动，避免用户只想复位偏移却换了形态） */
  const resetOffsets = () => updateSettings({ offsetX: 0, offsetY: 0 });

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">位置</h3>

      {/* 岛样式（形态） */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">岛样式</div>
        <div className="grid grid-cols-2 gap-2">
          {STYLES.map((s) => (
            <button
              key={s.key}
              onClick={() => updateSettings({ style: s.key })}
              className="px-3 py-2.5 rounded-lg text-[12px] font-medium text-center transition-all"
              style={{
                background: settings.style === s.key ? theme.cardBg : "transparent",
                border: `1px solid ${theme.border}`,
                cursor: "pointer",
                color: theme.text,
              }}
            >
              <div>{s.label}</div>
              <div className="text-[10px] mt-0.5" style={{ opacity: 0.5 }}>
                {s.hint}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 水平基准位置 */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">水平位置</div>
        <div className="flex gap-1">
          {POSITIONS.map((p) => (
            <button
              key={p.key}
              onClick={() => updateSettings({ horizontalPosition: p.key })}
              className="flex-1 py-1.5 px-3 rounded-md text-[11px] transition-all"
              style={{
                background:
                  settings.horizontalPosition === p.key ? theme.cardBg : "transparent",
                cursor: "pointer",
                border: `1px solid ${theme.border}`,
                color: theme.text,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* 水平微调 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">水平微调</span>
          <span className="tabular-nums">
            {settings.offsetX > 0 ? `+${settings.offsetX}` : settings.offsetX}px
          </span>
        </div>
        <input
          type="range"
          min={-200}
          max={200}
          step={1}
          value={settings.offsetX}
          onChange={(e) => updateSettings({ offsetX: Number(e.target.value) })}
        />
        <div className="flex justify-between text-[10px] mt-0.5 opacity-40">
          <span>左 200px</span>
          <span>右 200px</span>
        </div>
      </div>

      {/* 垂直微调 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">垂直微调</span>
          <span className="tabular-nums">{settings.offsetY}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={settings.offsetY}
          disabled={docked}
          onChange={(e) => updateSettings({ offsetY: Number(e.target.value) })}
          style={docked ? { opacity: 0.35 } : undefined}
        />
        {docked ? (
          <div className="text-[10px] mt-1" style={{ opacity: 0.55 }}>
            贴边挂角形态贴住屏幕顶边，不受垂直微调影响（该项对它无效）
          </div>
        ) : (
          <div className="flex justify-between text-[10px] mt-0.5 opacity-40">
            <span>贴顶（默认 8px 间距）</span>
            <span>下移 200px</span>
          </div>
        )}
      </div>

      <div>
        <button
          onClick={resetOffsets}
          className="px-3 py-1.5 rounded-md text-[11px]"
          style={{
            background: "var(--surface-1)",
            border: `1px solid ${theme.border}`,
            color: theme.text,
            cursor: "pointer",
          }}
        >
          微调归零
        </button>
      </div>
    </div>
  );
}
