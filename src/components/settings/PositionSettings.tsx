import { useState } from "react";
import { useSettings } from "../../stores/settings";
import { useI18n } from "../../i18n";
import type { IslandStyle, HorizontalPosition } from "../../types";
import { THEME_PRESETS } from "../../types";

/**
 * 岛的位置 —— 从「外观」里单拎出来独立成一个侧边栏页。
 *
 * 这里放的都是"岛摆在桌面哪儿"的设定：形态（悬浮胶囊 / 贴边挂角）、水平基准位置，
 * 以及在基准之上的左右/上下微调。外观页保留与位置无关的项（主题、圆角、透明度、宽度）。
 *
 * ⚠️ 两个微调滑块**拖动期间只改本地草稿，松开才写进设置**：
 *    偏移一变就会触发岛的窗口位移动画（280ms 缓动 + 每帧一次 setPosition）。
 *    拖动时每秒变十几次 → 窗口在追一个持续移动的目标，每次都被重新计时/重定向，
 *    屏幕上就是用户反馈的"抽搐"。改成松手才提交后，拖动纯粹是本地反馈，
 *    窗口只动一次。顺带把落盘次数从"一次拖动几十次"降到一次。
 */

const STYLES: { key: IslandStyle; labelKey: string; hintKey: string }[] = [
  { key: "floating", labelKey: "settings.position.styleFloating", hintKey: "settings.position.styleFloatingHint" },
  { key: "docked", labelKey: "settings.position.styleDocked", hintKey: "settings.position.styleDockedHint" },
];

const POSITIONS: { key: HorizontalPosition; labelKey: string }[] = [
  { key: "left", labelKey: "settings.position.horizontalLeft" },
  { key: "center", labelKey: "settings.position.horizontalCenter" },
  { key: "right", labelKey: "settings.position.horizontalRight" },
];

export default function PositionSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useI18n();
  const theme = THEME_PRESETS[settings.theme];
  const docked = settings.style === "docked";

  // 拖动中的草稿值（null = 没有未提交的改动，显示 settings 里的真值）
  const [draftX, setDraftX] = useState<number | null>(null);
  const [draftY, setDraftY] = useState<number | null>(null);

  /**
   * 提交草稿。绑在 pointerup / pointercancel / keyup / blur 上：
   *  - pointerup：鼠标/触摸拖动松手（range 输入框会隐式捕获指针，指针移出输入框也能收到）
   *  - keyup：键盘方向键调值
   *  - blur：兜底，万一 pointerup 丢了（比如在窗口外松开）
   */
  const commitOffsets = () => {
    const patch: { offsetX?: number; offsetY?: number } = {};
    if (draftX !== null) patch.offsetX = draftX;
    if (draftY !== null) patch.offsetY = draftY;
    if (patch.offsetX !== undefined || patch.offsetY !== undefined) updateSettings(patch);
    setDraftX(null);
    setDraftY(null);
  };

  const holdProps = {
    onPointerUp: commitOffsets,
    onPointerCancel: commitOffsets,
    onKeyUp: commitOffsets,
    onBlur: commitOffsets,
  };

  const shownX = draftX ?? settings.offsetX;
  const shownY = draftY ?? settings.offsetY;

  /** 把位置相关的两项一起复位；顺手清掉未提交的草稿，否则松手时会把旧草稿写回去 */
  const resetOffsets = () => {
    setDraftX(null);
    setDraftY(null);
    updateSettings({ offsetX: 0, offsetY: 0 });
  };

  return (
    <div className="space-y-5">
      <h3 className="text-[13px] font-semibold opacity-90">{t("settings.position.title")}</h3>

      {/* 岛样式（形态） */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">{t("settings.position.islandStyle")}</div>
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
              <div>{t(s.labelKey)}</div>
              <div className="text-[10px] mt-0.5" style={{ opacity: 0.5 }}>
                {t(s.hintKey)}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 水平基准位置 */}
      <div>
        <div className="text-[11px] opacity-60 mb-2">{t("settings.position.horizontal")}</div>
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
              {t(p.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* 水平微调 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.position.offsetX")}</span>
          <span className="tabular-nums">
            {shownX > 0 ? `+${shownX}` : shownX}px
          </span>
        </div>
        <input
          type="range"
          min={-200}
          max={200}
          step={1}
          value={shownX}
          onChange={(e) => setDraftX(Number(e.target.value))}
          {...holdProps}
        />
        <div className="flex justify-between text-[10px] mt-0.5 opacity-40">
          <span>{t("settings.position.offsetXMin")}</span>
          <span>{t("settings.position.offsetXMax")}</span>
        </div>
      </div>

      {/* 垂直微调 */}
      <div>
        <div className="flex justify-between text-[11px] mb-1.5">
          <span className="opacity-60">{t("settings.position.offsetY")}</span>
          <span className="tabular-nums">{shownY}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={shownY}
          disabled={docked}
          onChange={(e) => setDraftY(Number(e.target.value))}
          {...holdProps}
          style={docked ? { opacity: 0.35 } : undefined}
        />
        {docked ? (
          <div className="text-[10px] mt-1" style={{ opacity: 0.55 }}>
            {t("settings.position.dockedHint")}
          </div>
        ) : (
          <div className="flex justify-between text-[10px] mt-0.5 opacity-40">
            <span>{t("settings.position.offsetYMin")}</span>
            <span>{t("settings.position.offsetYMax")}</span>
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
          {t("settings.position.reset")}
        </button>
      </div>
    </div>
  );
}
