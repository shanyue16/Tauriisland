import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { useSettings } from "../stores/settings";
import { type HorizontalPosition, THEME_PRESETS } from "../types";
import SettingsPanel from "./SettingsPanel";
import TimePage from "../pages/TimePage";
import WeatherPage from "../pages/WeatherPage";
import MusicPage from "../pages/MusicPage";
import PageIndicator from "./PageIndicator";
import { useWeather } from "../hooks/useWeather";
import { useMusic } from "../hooks/useMusic";
import { controlMusic } from "../services/music";
import { getCurrentLyric } from "../services/lyrics";
import { getWeatherIcon } from "./Icons";
import type { WeatherData } from "../types/weather";
import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";

// 四态架构
const MEDIUM_PAGES = 3; // 时间页(0), 天气页(1), 音乐页(2)
// 最后一个"页面"索引触发设置面板
const SETTINGS_PAGE_INDEX = MEDIUM_PAGES; // = 3

// 固定尺寸
const MINIMAL_H = 48;
const MEDIUM_H = 64;
const EXPANDED_W = 420;
const EXPANDED_H = 220; // 比线框略高，给边框动画留呼吸空间
const MAXIMAL_W = 520;
const MAXIMAL_H = 280;

const appWindow = getCurrentWindow();

// easeOutCubic: 先快后慢，最自然的过渡感
function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// 动画时长 ms — 和 CSS transition 统一
const ANIM_DURATION = 280;

export default function Island() {
  const { settings, state, setState, currentPage, setCurrentPage } =
    useSettings();
  // 共享天气数据源 —— 一处 fetch, minimal/medium 两态共用
  const { data: weatherData } = useWeather();
  // 共享音乐数据源
  const { data: musicData, lyrics } = useMusic();
  const hoverTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);

  // 当前窗口实际尺寸（上一次动画结束后的值）
  const currentSizeRef = useRef({ w: 220, h: 48 });
  const currentPosRef = useRef({ x: 0, y: 8 });
  // 正在运行的动画帧 ID，用于取消前一次动画
  const animFrameRef = useRef<number | null>(null);

  // 计算尺寸（CSS 像素 = 逻辑像素）
  const MINIMAL_H = 48;
  const MEDIUM_H = 64;

  // 计算尺寸
  // minimal 态有音乐时自动拉长宽度（让封面+歌名+时间能装下）
  const hasMusic = musicData?.active && musicData.playing;
  const MINIMAL_W_WITH_MUSIC = 320;

  const getSize = () => {
    if (state === "minimal") return { w: hasMusic ? MINIMAL_W_WITH_MUSIC : settings.minimalWidth, h: MINIMAL_H };
    if (state === "medium") return { w: settings.mediumWidth, h: MEDIUM_H };
    if (state === "expanded") return { w: EXPANDED_W, h: EXPANDED_H };
    return { w: MAXIMAL_W, h: MAXIMAL_H };
  };

  const size = getSize();

  // 计算目标位置
  const getTargetPos = useCallback(
    (w: number) => {
      const screenW = window.screen.width;
      const y = settings.style === "docked" ? 0 : 8;
      let x: number;
      switch (settings.horizontalPosition as HorizontalPosition) {
        case "left":
          x = 16;
          break;
        case "right":
          x = screenW - w - 16;
          break;
        case "center":
        default:
          x = (screenW - w) / 2;
      }
      return { x, y };
    },
    [settings.style, settings.horizontalPosition]
  );

  // ====== 关键：带平滑动画的 OS 窗口尺寸/位置过渡 ======
  // Windows 上 Tauri setSize / setPosition 不支持原生动画
  // 用 requestAnimationFrame 手动插值，每帧调用一次，约 60fps
  const animateWindow = useCallback(
    async (targetW: number, targetH: number) => {
      // 取消前一次还在跑的动画（快速切换状态时避免互相干扰）
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }

      const startW = currentSizeRef.current.w;
      const startH = currentSizeRef.current.h;
      const targetPos = getTargetPos(targetW);
      const startPos = currentPosRef.current;

      const startTime = performance.now();

      const tick = async () => {
        const now = performance.now();
        const t = Math.min((now - startTime) / ANIM_DURATION, 1);
        const eased = easeOutCubic(t);

        const w = startW + (targetW - startW) * eased;
        const h = startH + (targetH - startH) * eased;
        const x = startPos.x + (targetPos.x - startPos.x) * eased;
        const y = startPos.y + (targetPos.y - startPos.y) * eased;

        // 关键：每帧都更新 ref，这样即使动画被中途取消，
        // 下一次动画也能从当前实际尺寸继续，而不是跳回起点
        currentSizeRef.current = { w, h };
        currentPosRef.current = { x, y };

        try {
          await appWindow.setSize(new LogicalSize(w, h));
          await appWindow.setPosition(new LogicalPosition(x, y));
        } catch {
          // ignore — 窗口可能在动画过程中被关闭
        }

        if (t < 1) {
          animFrameRef.current = requestAnimationFrame(tick);
        } else {
          // 动画结束，精确对齐目标值（避免浮点误差累积）
          currentSizeRef.current = { w: targetW, h: targetH };
          currentPosRef.current = targetPos;
          animFrameRef.current = null;
        }
      };

      animFrameRef.current = requestAnimationFrame(tick);
    },
    [getTargetPos]
  );

  // 每次 state / size 变化，触发带动画的 OS 窗口过渡
  useEffect(() => {
    animateWindow(size.w, size.h);
  }, [size.w, size.h, animateWindow]);

  // 组件卸载时清理动画
  useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  // 计算圆角样式
  // 仅小型态强制 borderRadius = 高度/2 (胶囊);
  // 中型 / 大型态直接用 settings.borderRadius, 保持长方形圆角感
  const getBorderRadius = (heightPx: number) => {
    const isMinimal = heightPx < 60;
    const effective = isMinimal
      ? Math.max(settings.borderRadius, heightPx / 2)
      : settings.borderRadius;
    const r = `${effective}px`;
    if (settings.style === "docked") {
      return `0 0 ${r} ${r}`;
    }
    return r;
  };

  // 清理所有定时器
  const clearTimers = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  // 鼠标进入
  const handleMouseEnter = useCallback(() => {
    clearTimers();
    if (state === "minimal") {
      hoverTimerRef.current = window.setTimeout(() => {
        setState("medium");
      }, settings.hoverDelay);
    }
  }, [state, settings.hoverDelay, clearTimers, setState]);

  // 鼠标离开
  const handleMouseLeave = useCallback(() => {
    clearTimers();
    if (state === "maximal") {
      collapseTimerRef.current = window.setTimeout(() => {
        setState("medium");
        setCurrentPage(0);
      }, 3000);
    } else if (state === "expanded") {
      collapseTimerRef.current = window.setTimeout(() => {
        setState("medium");
      }, 2500);
    } else if (state === "medium") {
      collapseTimerRef.current = window.setTimeout(() => {
        setState("minimal");
      }, settings.collapseDelay);
    }
  }, [state, settings.collapseDelay, clearTimers, setState, setCurrentPage]);

  // 滚轮翻页 / 状态切换
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!settings.wheelEnabled) return;
      e.preventDefault();

      if (state === "minimal") {
        setState("medium");
        return;
      }

      if (state === "medium") {
        if (e.deltaY > 0) {
          if (currentPage === 2) {
            // 音乐页 → 展开态
            setState("expanded");
          } else if (currentPage >= MEDIUM_PAGES - 1) {
            // 最后一页 → 最大态（设置面板）
            setCurrentPage(SETTINGS_PAGE_INDEX);
            setState("maximal");
          } else {
            setCurrentPage(currentPage + 1);
          }
        } else {
          if (currentPage <= 0) {
            setCurrentPage(MEDIUM_PAGES - 1);
          } else {
            setCurrentPage(currentPage - 1);
          }
        }
      } else if (state === "expanded") {
        if (e.deltaY > 0) {
          // 继续下 → 最大态
          setCurrentPage(0);
          setState("maximal");
        } else {
          // 上 → 悬浮态音乐页
          setCurrentPage(2);
          setState("medium");
        }
      } else if (state === "maximal") {
        // 上滑 → 回悬浮态
        if (e.deltaY < 0) {
          setCurrentPage(0);
          setState("medium");
        }
      }
    },
    [state, currentPage, settings.wheelEnabled, setState, setCurrentPage]
  );

  // Esc 关闭 expanded / maximal
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (state === "maximal") {
          setState("medium");
          setCurrentPage(0);
        } else if (state === "expanded") {
          setState("medium");
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, setState, setCurrentPage]);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  const floating = settings.style === "floating";
  const theme = THEME_PRESETS[settings.theme];

  // CSS 变量：让 index.css 里的所有组件（滑块/开关/sidebar-tab）自适应主题
  const cssVars: React.CSSProperties = (
    settings.theme === "dark"
      ? {
          "--island-text": "#ffffff",
          "--island-text-muted": "rgba(255,255,255,0.65)",
          "--sidebar-tab-hover": "rgba(255,255,255,0.08)",
          "--sidebar-tab-active": "rgba(255,255,255,0.14)",
          "--sidebar-tab-active-hover": "rgba(255,255,255,0.2)",
          "--slider-track": "rgba(255,255,255,0.15)",
          "--slider-thumb-bg": "#ffffff",
          "--switch-track": "rgba(255,255,255,0.2)",
          "--switch-thumb-bg": "#ffffff",
        }
      : {
          "--island-text": "#1d1d1f",
          "--island-text-muted": "rgba(29,29,31,0.55)",
          "--sidebar-tab-hover": "rgba(0,0,0,0.06)",
          "--sidebar-tab-active": "rgba(0,0,0,0.1)",
          "--sidebar-tab-active-hover": "rgba(0,0,0,0.14)",
          "--slider-track": "rgba(0,0,0,0.12)",
          "--slider-thumb-bg": "#ffffff",
          "--switch-track": "rgba(0,0,0,0.15)",
          "--switch-thumb-bg": "#ffffff",
        }
  ) as React.CSSProperties;

  // 关键思路：Windows WebView2 transparent 窗口边缘天然是黑的，
  // 与其硬遮不如让它成为设计的一部分 —— 做一圈很细的深色阴影环
  // 把内外层间隙缩到 2px (看起来像阴影，不像破框)
  const PAD = 2;
  const dockedPad = { top: 0, left: PAD, right: PAD, bottom: PAD };
  const floatingPad = { top: PAD, left: PAD, right: PAD, bottom: PAD };
  const pad = floating ? floatingPad : dockedPad;

  // 把 preset 的 "rgb(r,g,b)" 和 用户 alpha 组合成 rgba()
  const applyAlpha = (rgb: string, alpha: number) => {
    // rgb 格式: "rgb(r, g, b)" → 提取三个数字
    const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
    }
    return rgb; // 已经是 rgba/hex 就原样返回
  };

  const bgWithAlpha = applyAlpha(theme.bg, settings.opacity / 100);

  // 状态标记（提前声明，outerStyle/innerStyle 都要用到）
  const isExpanded = state === "expanded";
  const isDark = settings.theme === "dark";

  // 外层：填满 OS 窗口，圆角裁剪
  // expanded 态让 SVG 灯带能溢出到窗口阴影区（overflow: visible）
  const outerStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: getBorderRadius(size.h),
    overflow: isExpanded ? "visible" : "hidden",
    cursor: "pointer",
    transition:
      "border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1), overflow 0ms",
  };

  // 内层：岛主体
  // —— 四周 4px 内缩（内容不贴边，给 SVG 灯带让位）
  // —— expanded 态 border=none（SVG 灯带在外面）
  const innerPad = isExpanded ? 4 : 2;
  const innerStyle: React.CSSProperties = {
    position: "absolute",
    top: innerPad,
    left: innerPad,
    right: innerPad,
    bottom: innerPad,
    borderRadius: getBorderRadius(size.h),
    backgroundColor: bgWithAlpha,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: isExpanded ? "none" : `1px solid ${theme.border}`,
    boxShadow: isDark
      ? isExpanded
        ? ["0 4px 20px rgba(0,0,0,0.55)", "inset 0 0 0 1px rgba(0,0,0,0.4)"].join(", ")
        : [
            "0 4px 16px rgba(0, 0, 0, 0.5)",
            "0 1px 2px rgba(0, 0, 0, 0.4)",
            "inset 0 0 0 2px rgba(0, 0, 0, 0.6)",
          ].join(", ")
      : [
          "0 4px 16px rgba(0, 0, 0, 0.12)",
          "0 1px 2px rgba(0, 0, 0, 0.08)",
          "inset 0 0 0 2px rgba(0, 0, 0, 0.08)",
        ].join(", "),
    overflow: "visible",
    transition:
      "border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 180ms ease, border-color 180ms ease",
  };

  return (
    <div
      style={{ ...outerStyle, ...cssVars }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onWheel={handleWheel}
    >
      {/* expanded 态 SVG 呼吸律动边框 —— 挂在 outerStyle 下，能溢出到阴影区 */}
      {isExpanded && <ExpandedBorder radius={getBorderRadius(size.h)} />}

      <div style={innerStyle}>
        {/* 四层内容同时 mounted，用 opacity + pointerEvents 切换可见性 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: state === "minimal" ? 1 : 0,
            pointerEvents: state === "minimal" ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <MinimalContent weatherData={weatherData} musicData={musicData} />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: state === "medium" ? 1 : 0,
            pointerEvents: state === "medium" ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <MediumContent page={currentPage} weatherData={weatherData} musicData={musicData} lyrics={lyrics} />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: state === "expanded" ? 1 : 0,
            pointerEvents: state === "expanded" ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <MusicDetailView data={musicData} lyrics={lyrics} />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: state === "maximal" ? 1 : 0,
            pointerEvents: state === "maximal" ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}

// ===== 最小态内容 =====
// 无音乐: 时间+星期 | 天气简述
// 有音乐: EQ封面+歌名+时间 (拉长 320px)
function MinimalContent({
  weatherData,
  musicData,
}: {
  weatherData: WeatherData | null;
  musicData: MusicData | null;
}) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = time.getHours().toString().padStart(2, "0");
  const mm = time.getMinutes().toString().padStart(2, "0");
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  const hasActiveMusic = musicData?.active && musicData.title;

  // —— 有音乐时：封面 + 歌名 + 时间 ——
  if (hasActiveMusic) {
    return (
      <div className="w-full h-full flex items-center gap-2.5 px-3" style={{ color }}>
        {/* 真实封面 (无则 EQ 占位) */}
        <div
          className="relative shrink-0 rounded-md overflow-hidden flex items-center justify-center"
          style={{
            width: 28, height: 28,
            background: musicData.cover_url ? "transparent" : "linear-gradient(135deg, #f472b6, #60a5fa)",
            boxShadow: musicData.cover_url ? "0 2px 6px rgba(0,0,0,0.3)" : "0 2px 8px rgba(244,114,182,0.3)",
          }}
        >
          {musicData.cover_url ? (
            <img src={musicData.cover_url} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : musicData.playing ? (
            <div className="flex items-end gap-[2px] h-3.5">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="w-[2px] rounded-full bg-white animate-eq-bar"
                  style={{ animationDelay: `${i * 0.15}s`, height: "14px" }}
                />
              ))}
            </div>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#fff", opacity: 0.6 }}>
              <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
            </svg>
          )}
        </div>

        {/* 歌名 + 艺术家 */}
        <div className="flex flex-col flex-1 min-w-0 leading-tight">
          <span className="text-[11px] font-medium truncate">{musicData.title || "未知曲目"}</span>
          {musicData.artist && (
            <span className="text-[9px] truncate" style={{ color: muted }}>{musicData.artist}</span>
          )}
        </div>

        {/* 时间 */}
        <span
          className="text-[11px] font-medium tabular-nums shrink-0"
          style={{ color: muted }}
        >
          {hh}:{mm}
        </span>
      </div>
    );
  }

  // —— 无音乐：时间+星期 | 天气简述 ——
  return (
    <div className="w-full h-full flex items-center justify-center gap-2 px-3 text-[12px] leading-none" style={{ color }}>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="font-medium tabular-nums">
          {hh}:{mm}
        </span>
        <span className="opacity-60">{weekdays[time.getDay()]}</span>
      </div>
      <div style={{ width: 12, flexShrink: 0 }} />
      {weatherData ? (
        <div className="flex items-center gap-1 shrink-0" style={{ color: muted }}>
          <WeatherMini data={weatherData} />
        </div>
      ) : (
        <div className="shrink-0" style={{ width: 40 }} />
      )}
    </div>
  );
}

// 最小态里的天气子组件: 图标 + 温度文本 "晴 17°"
function WeatherMini({ data }: { data: WeatherData }) {
  const Icon = getWeatherIcon(data.weather_icon);
  const temp = Math.round(data.temperature);
  const desc = data.weather || "";

  return (
    <div className="flex items-center gap-1">
      <Icon size={14} style={{ color: "var(--island-text)", opacity: 0.75 }} />
      <span style={{ color: "var(--island-text)", opacity: 0.85 }}>
        {desc} {temp}°
      </span>
    </div>
  );
}

// ===== 中等态内容 =====
function MediumContent({
  page,
  weatherData,
  musicData,
  lyrics,
}: {
  page: number;
  weatherData: WeatherData | null;
  musicData: MusicData | null;
  lyrics: import("../types/lyrics").LyricLine[];
}) {
  return (
    <div className="w-full h-full relative">
      {/* 时间页 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: page === 0 ? 1 : 0,
          pointerEvents: page === 0 ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}
      >
        <TimePage />
      </div>
      {/* 天气页 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: page === 1 ? 1 : 0,
          pointerEvents: page === 1 ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}
      >
        <WeatherPage data={weatherData} />
      </div>
      {/* 音乐页 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: page === 2 ? 1 : 0,
          pointerEvents: page === 2 ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}
      >
        <MusicPage data={musicData} lyrics={lyrics} />
      </div>
    </div>
  );
}

// ===== expanded 态 SVG 呼吸律动边框 =====
// 接收 outerStyle 的 radius，rect 覆盖 outerStyle 整个区域
function ExpandedBorder({ radius }: { radius: string }) {
  // 把 CSS radius "24px" 转成 SVG rx/ry
  const r = parseInt(radius) || 24;
  // rect 覆盖 outerStyle 的 0-100%, viewBox 100x100 所以 radius 也按比例
  const svgRx = (r / 420) * 100; // expanded 宽度 420
  const svgRy = (r / 220) * 100; // expanded 高度 220

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 20,
        overflow: "visible",
      }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="rainbowGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#f472b6" />
          <stop offset="16%"  stopColor="#c084fc" />
          <stop offset="32%"  stopColor="#60a5fa" />
          <stop offset="48%"  stopColor="#22d3ee" />
          <stop offset="64%"  stopColor="#86efac" />
          <stop offset="80%"  stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#f472b6" />
        </linearGradient>
      </defs>
      <rect
        x="0.5" y="0.5" width="99" height="99"
        rx={svgRx} ry={svgRy}
        fill="none"
        stroke="url(#rainbowGradient)"
        strokeWidth={1.2}
        className="island-belt-static"
      />
    </svg>
  );
}

// ===== expanded 态音乐详情（两行布局 + 音频可视化 + 封面光晕） =====
function MusicDetailView({
  data,
  lyrics,
}: {
  data: MusicData | null;
  lyrics: import("../types/lyrics").LyricLine[];
}) {
  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  // 封面主色（未来从 sidecar dominant_color 提取，目前占位）
  const accentColor = "#f472b6";
  const accentColor2 = "#60a5fa";

  if (!data?.active) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-[18px]" style={{ color }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
          <path d="M9 18V5l12-2v13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span className="text-[12px]" style={{ color: muted }}>暂无活跃音乐</span>
      </div>
    );
  }

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  // timeline 为 0 时用模拟进度；duration 也为 0 时不显示百分比
  const hasRealDuration = data.duration > 0;
  const progress = hasRealDuration
    ? Math.min((data.position / data.duration) * 100, 100)
    : 0;

  // SMTC 控制
  const handlePlayPause = async () => {
    await controlMusic("toggle");
  };
  const handlePrev = async () => {
    await controlMusic("prev");
  };
  const handleNext = async () => {
    await controlMusic("next");
  };

  // 音频可视化柱条 — 24 根
  const bars = Array.from({ length: 24 });

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ color }}>
      {/* 背景音频可视化（位于最底层） */}
      <div
        className="absolute inset-0 pointer-events-none flex items-end gap-[3px] px-4 pb-4"
        style={{ zIndex: 0, opacity: data.playing ? 0.35 : 0.12 }}
      >
        {bars.map((_, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm"
            style={{
              minHeight: 4,
              background: `linear-gradient(to top, ${accentColor}, ${accentColor2})`,
              animation: data.playing
                ? `vizBar${(i % 4) + 1} ${0.6 + (i % 3) * 0.15}s ease-in-out infinite alternate`
                : "none",
              animationDelay: `${i * 0.04}s`,
              height: data.playing ? undefined : 6,
            }}
          />
        ))}
      </div>

      {/* 内容层 */}
      <div className="w-full h-full flex flex-col gap-3 px-[18px] py-[14px] relative" style={{ zIndex: 1 }}>
        {/* 第一行：封面(带光晕) + 歌曲信息 + 歌词 */}
        <div className="flex flex-row gap-4 items-stretch flex-1 min-h-0">
          {/* 封面：真实 cover_url，加光晕 */}
          <div
            className="relative shrink-0 rounded-lg overflow-hidden"
            style={{
              width: 84, height: 84,
              background: data.cover_url ? "transparent" : "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: `
                0 0 0 1px rgba(255,255,255,0.06),
                0 0 12px 2px ${accentColor}40,
                0 0 24px 4px ${accentColor2}25,
                0 4px 16px rgba(0,0,0,0.4)
              `,
            }}
          >
            {data.cover_url ? (
              <img
                src={data.cover_url}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center opacity-30">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
                </svg>
              </div>
            )}
          </div>

          {/* 歌曲信息 */}
          <div className="flex flex-col justify-center gap-1 min-w-0" style={{ flex: "0 0 34%" }}>
            <div className="text-[15px] font-semibold truncate">{data.title || "未知曲目"}</div>
            {data.artist && (
              <div className="text-[11px] truncate" style={{ color: muted }}>
                {data.artist}{data.album ? ` · ${data.album}` : ""}
              </div>
            )}
            {data.app_name && (
              <div className="text-[9px]" style={{ color: muted, opacity: 0.5 }}>{data.app_name}</div>
            )}
          </div>

          {/* 歌词区（透明融入） */}
          <LyricsBlock lyrics={lyrics} positionMs={(data.position || 0) * 1000} playing={data.playing} />
        </div>

        {/* 第二行：控件 + 进度条 */}
        <div className="flex flex-row items-center gap-3 mt-1">
          <div className="flex items-center justify-center gap-2 shrink-0">
            <button
              onClick={handlePrev}
              className="flex items-center justify-center p-1 text-white/85 hover:text-white hover:scale-110 active:scale-95 transition-all cursor-pointer"
              style={{ background: "none", border: "none" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button
              onClick={handlePlayPause}
              className="flex items-center justify-center rounded-full shrink-0 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              style={{
                width: 34, height: 34,
                background: "rgba(255,255,255,0.12)",
                border: `1px solid ${accentColor}40`,
                boxShadow: `0 0 8px ${accentColor}30`,
                color: "#fff",
              }}
            >
              {data.playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>
            <button
              onClick={handleNext}
              className="flex items-center justify-center p-1 text-white/85 hover:text-white hover:scale-110 active:scale-95 transition-all cursor-pointer"
              style={{ background: "none", border: "none" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>
          <div className="flex flex-col gap-1.5 min-w-0" style={{ flex: 1 }}>
            <div className="w-full h-[3px] rounded-full overflow-hidden relative" style={{ background: "rgba(255,255,255,0.15)" }}>
              <div className="h-full rounded-full" style={{
                width: `${Math.max(progress, hasRealDuration ? 0 : 2)}%`,
                background: `linear-gradient(90deg, ${accentColor}, ${accentColor2})`,
                transition: "width 0.3s linear",
              }} />
            </div>
            <div className="flex justify-between" style={{ fontSize: 9, color: muted, fontVariantNumeric: "tabular-nums" }}>
              <span>{formatTime(data.position)}</span>
              <span>{hasRealDuration ? formatTime(data.duration) : "—:—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== 歌词显示组件 =====
// 显示附近 3 行歌词（上一行 + 当前行 + 下一行），当前行高亮
function LyricsBlock({
  lyrics,
  positionMs,
  playing,
}: {
  lyrics: LyricLine[];
  positionMs: number;
  playing: boolean;
}) {
  // 找当前歌词行索引
  const currentIdx = lyrics.length > 0
    ? lyrics.reduce<number | null>(
        (acc, line, idx) => (line.time_ms <= positionMs ? idx : acc),
        null
      )
    : null;

  // 无歌词 → 空状态
  if (lyrics.length === 0) {
    return (
      <div
        className="flex flex-col justify-center items-center gap-[3px] text-center flex-1 min-w-0 px-2"
        style={{ background: "transparent" }}
      >
        <div className="text-[10px]" style={{ opacity: 0.28 }}>等待歌词…</div>
        <div className="text-[12px] font-medium" style={{ opacity: 1 }}>
          {playing ? "♪ 正在播放" : "⏸ 已暂停"}
        </div>
      </div>
    );
  }

  // 显示上一行、当前行、下一行
  const startIdx = Math.max(0, (currentIdx ?? 0) - 1);
  const endIdx = Math.min(lyrics.length, startIdx + 3);
  const nearby = lyrics.slice(startIdx, endIdx);

  return (
    <div
      className="flex flex-col justify-center items-center gap-[4px] text-center flex-1 min-w-0 px-2"
      style={{ background: "transparent" }}
    >
      {nearby.map((line, i) => {
        const isCurrent = startIdx + i === currentIdx;
        return (
          <div
            key={`${startIdx + i}-${line.time_ms}`}
            className="truncate max-w-full"
            style={{
              fontSize: isCurrent ? 12 : 10,
              fontWeight: isCurrent ? 500 : 400,
              opacity: isCurrent ? 1 : 0.35,
              transition: "opacity 200ms ease, font-size 200ms ease",
              lineHeight: 1.3,
            }}
          >
            {line.text}
          </div>
        );
      })}
    </div>
  );
}
