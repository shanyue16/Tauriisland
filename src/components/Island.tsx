import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../stores/settings";
import { type HorizontalPosition, type IslandState, THEME_PRESETS } from "../types";
import SettingsPanel from "./SettingsPanel";
import TimePage from "../pages/TimePage";
import WeatherPage from "../pages/WeatherPage";
import MusicPage from "../pages/MusicPage";
import CalendarPage from "../pages/CalendarPage";
import NotificationPage from "../pages/NotificationPage";
import NotificationAlert from "./NotificationAlert";
import IslandTooltip from "./IslandTooltip";
import { fetchNotifications } from "../services/notifications";
import { isBlacklisted, type NotificationItem } from "../types/notification";
import PageIndicator from "./PageIndicator";
import AudioWaveLine from "./AudioWaveLine";
import { useCoverAccent } from "../hooks/useCoverAccent";
import { useWeather } from "../hooks/useWeather";
import { useMusic } from "../hooks/useMusic";
import { controlMusic } from "../services/music";
import { getCurrentLyric } from "../services/lyrics";
import { getWeatherIcon } from "./Icons";
import type { WeatherData } from "../types/weather";
import type { MusicData } from "../types/music";
import type { LyricLine } from "../types/lyrics";
import {
  MEDIUM_PAGES,
  EXPANDED_PAGES,
  MEDIUM_MUSIC_INDEX,
  EXPANDED_MUSIC_INDEX,
  SETTINGS_PAGE_INDEX,
  isLastMediumPage,
  isLastExpandedPage,
  expandedPageOnReturn,
  mediumPageOnReturn,
} from "../utils/pages";
import { canScrollableAncestorScroll } from "../utils/scroll";

// 页面路由全部集中在 utils/pages.ts（顺序、总数、跨态回落规则）
// —— 这里不再写死 `currentPage === 2` 这类魔法数字，加页/调序才不会静默失效。

// 固定尺寸
const MINIMAL_H = 56;
const MEDIUM_H = 74;
const EXPANDED_W = 530; // 原 420：日历页左右分栏 + 更大的「休/班」徽标需要更宽的画布
const EXPANDED_H = 280; // 原 220：日历页上下不再拥挤
/**
 * 新通知提醒的高度 —— 比展开态矮得多，因为它只显示一条通知
 * （应用名 + 标题 2 行 + 正文 2 行）。宽度沿用 EXPANDED_W，视觉上与展开态一致。
 */
/**
 * 新通知提醒的高度范围。
 *
 * 实际高度**不写死**：由 Island 测量提醒内容的真实高度后再钳制到这个区间，
 * 所以短通知（只有标题）得到一个矮窗口，长通知（标题+正文多行）得到高窗口。
 */
const ALERT_MIN_H = 68;
const ALERT_MAX_H = 140;
/** minimal 态有音乐时自动拉长宽度（让封面 + 歌名 + 时间能装下） */
const MINIMAL_W_WITH_MUSIC = 320;
/**
 * 展开态给窗口阴影预留的四周留白。
 * 岛本体原来 inset:0 填满整个窗口，18px 的阴影只能画出 3px 就被窗口边界裁断，
 * 在四周形成一圈"硬"的深色边（用户看到的长方形黑边的一部分）。
 * 现在窗口 = 岛本体 + 两侧留白，阴影有空间自然扩散。
 */
const SHADOW_PAD = 12;
/**
 * 最大态（设置页）尺寸 = 展开态尺寸（**含四周 SHADOW_PAD 留白**）。
 *
 * 用户要求：「最大态(设置页)的尺寸改为与展开态相同」。所以这里直接从展开态常量推导，
 * 窗口 554×304、岛体 530×280 —— 与展开态逐像素一致；从展开态滚进设置页时窗口尺寸
 * 完全不变（不再有 520→554 的跳变）。
 *
 * ⚠️ 光把窗口改大不够：必须让 maximal 也走 `isExpandedLayout` 那套几何
 *    （outerStyle.inset=SHADOW_PAD、innerPad=3），否则窗口变大而岛体尺寸不变，
 *    圆角岛四周会露出一圈透明留白。
 * ⚠️ 窗口高度 304 仍在 tauri.conf.json 的 maxHeight=320 之内，不会被系统钳掉。
 */
const MAXIMAL_W = EXPANDED_W + SHADOW_PAD * 2;
const MAXIMAL_H = EXPANDED_H + SHADOW_PAD * 2;

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
  // expanded 态当前页（仅 UI 局部状态，不进 store；默认音乐页）
  const [expandedPage, setExpandedPage] = useState(0);
  /**
   * 跨态回落记忆：从某个态"往上滚"时回到原来那一页，而不是固定回首页。
   * - lastExpandedPageRef：进入设置面板(maximal)前所在的展开页 → 从设置页上滚回到它
   * - lastMediumPageRef：进入展开态前所在的悬浮页 → 从展开态上滚回到它
   * 用 ref 而不是 state：只做"记住上次位置"，不需要触发重渲染。
   */
  const lastExpandedPageRef = useRef(0);
  const lastMediumPageRef = useRef(MEDIUM_MUSIC_INDEX);
  /** 设置面板是从哪个态进来的 —— 决定上滚时该回展开态还是悬浮态 */
  const maximalFromRef = useRef<"expanded" | "medium">("expanded");

  /**
   * 新通知提醒：短暂把岛当成展开态来显示一条通知。
   *
   * 关键点：**不改 `state`**。用户的导航状态（minimal/medium/expanded/maximal 与当前页）
   * 保持不变，提醒只是临时借用展开态的尺寸与一层覆盖内容，收起后就回到原样。
   * 尺寸由 getSize() 里的 `alert ? 展开尺寸 : 正常尺寸` 决定，所以窗口会跟着变大再缩回。
   */
  const [alertItem, setAlertItem] = useState<NotificationItem | null>(null);
  const alertTimerRef = useRef<number | null>(null);
  /** 指针是否停在提醒上（停住时不自动收起，等移开再重新计时） */
  const alertHoverRef = useRef(false);

  /**
   * 提醒内容的实测高度（ResizeObserver 量出来）。
   *
   * 提醒窗口**不写死高度**：内容长就高、内容短就矮。测的是提醒内容那一层的高度
   * （含它自己的 padding），该层宽度恒等于岛体宽度，所以量出来的高度可直接当窗口高度。
   * 复用同一个 observer：换通知时 React 会复用该 DOM 节点、observer 继续有效。
   */
  const [alertHeight, setAlertHeight] = useState<number | null>(null);
  const alertObserverRef = useRef<ResizeObserver | null>(null);

  /** 回调 ref：挂载/换节点时重新观察，量到的内容高度直接写进 state */
  const alertMeasureRef = useCallback((el: HTMLDivElement | null) => {
    if (alertObserverRef.current) {
      alertObserverRef.current.disconnect();
      alertObserverRef.current = null;
    }
    if (!el) return;
    const measure = () => {
      const measured = Math.round(el.getBoundingClientRect().height);
      if (measured > 0) setAlertHeight((prev) => (prev === measured ? prev : measured));
    };
    measure();
    // 观察尺寸变化：字体/换行/内容变化都能自动跟上
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    alertObserverRef.current = ro;
  }, []);

  // minimal 态有音乐时自动拉长宽度（让封面+歌名+时间能装下）。
  // 说明放在 showAlert 之前：提醒校准动画基准时要按当前态算宽度。
  const hasMusic = musicData?.active && musicData.playing;

  /**
   * 显示一条提醒。
   *
   * 两种情况不打扰用户：① 已经处在展开态/设置面板 —— 他正在看岛，弹提醒是噪音，
   * 列表会在下一轮轮询里自己更新；② 用户关了提醒开关（effect 里已拦，这里再兜一层）。
   *
   * ⚠️ 用 `stateRef` 而不是把 `state` 放进依赖：本回调被全局探测 effect 依赖，
   * 一旦随 `state` 变化，探测定时器就会每次状态切换都重建、`seen` 基线反复清零
   * （表现为"提醒时快时慢、偶尔漏弹"）。依赖必须保持稳定。
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  const showAlert = useCallback(
    (item: NotificationItem) => {
      const s = stateRef.current;
      if (s === "expanded" || s === "maximal") return;
      // 先把动画基准校准成"当前基础态尺寸"，避免从陈旧尺寸插值造成跳变。
      // 提醒可以在任意态弹出，所以基准要按当前态算。
      const base =
        s === "minimal"
          ? { w: hasMusic ? MINIMAL_W_WITH_MUSIC : settings.minimalWidth, h: MINIMAL_H }
          : s === "medium"
            ? { w: settings.mediumWidth, h: MEDIUM_H }
            : { w: MAXIMAL_W, h: MAXIMAL_H };
      currentSizeRef.current = base;
      // 新提醒一律从"指针不在提醒上"开始：否则上一条提醒留下的悬停标记会让
      // 新提醒的计时器一启动就自我顺延，永远不收起。
      alertHoverRef.current = false;
      // 新提醒从"未测量"开始，先按最小高度弹出，量到真实高度后再撑开
      setAlertHeight(null);
      setAlertItem(item);
    },
    [hasMusic, settings.minimalWidth, settings.mediumWidth]
  );

  // 当前窗口实际尺寸（上一次动画结束后的值）
  const currentSizeRef = useRef({ w: 220, h: 48 });
  const currentPosRef = useRef({ x: 0, y: 8 });
  // 正在运行的动画帧 ID，用于取消前一次动画
  const animFrameRef = useRef<number | null>(null);


  // 计算尺寸

  const getSize = () => {
    // 提醒借用展开态宽度，高度按实测内容钳制（内容长→高，内容短→矮）。
    // 测量未完成时先用 ALERT_MIN_H 兜底，测完立刻换真实值。
    if (alertItem) {
      const measured = alertHeight ?? ALERT_MIN_H;
      const h = Math.min(Math.max(measured, ALERT_MIN_H), ALERT_MAX_H);
      return { w: EXPANDED_W + SHADOW_PAD * 2, h: h + SHADOW_PAD * 2 };
    }
    if (state === "minimal") return { w: hasMusic ? MINIMAL_W_WITH_MUSIC : settings.minimalWidth, h: MINIMAL_H };
    if (state === "medium") return { w: settings.mediumWidth, h: MEDIUM_H };
    // 展开态与最大态（设置页）尺寸完全相同 —— 同一个岛体 + 同一圈留白
    if (state === "expanded" || state === "maximal") {
      return { w: EXPANDED_W + SHADOW_PAD * 2, h: EXPANDED_H + SHADOW_PAD * 2 };
    }
    return { w: MAXIMAL_W, h: MAXIMAL_H };
  };

  const size = getSize();

  // 计算目标位置
  const getTargetPos = useCallback(
    (w: number) => {
      const screenW = window.screen.width;
      // 悬浮：顶部留 8px。
      // 贴边挂角：**岛体**顶边必须与屏幕顶边齐平（用户反馈"最上的边与桌面有一定距离"）。
      //   注意展开态/最大态/通知提醒的窗口四周带 SHADOW_PAD 留白，此时窗口要整体上移
      //   -SHADOW_PAD，岛体顶边才会落在 y=0；配合 innerStyle 的上边零内缩才真正贴边。
      const expandedGeometry = state === "expanded" || state === "maximal" || alertItem !== null;
      const y = settings.style === "docked" ? (expandedGeometry ? -SHADOW_PAD : 0) : 8;
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
    [settings.style, settings.horizontalPosition, state, alertItem]
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
    // 提醒显示期间锁住状态：否则悬停会把 minimal 顶成 medium，提醒收起后
    // 用户会莫名其妙停在悬浮态（并且底下那层已经在动）
    if (alertItem) return;
    if (state === "minimal") {
      hoverTimerRef.current = window.setTimeout(() => {
        setState("medium");
      }, settings.hoverDelay);
    }
  }, [state, settings.hoverDelay, clearTimers, setState, alertItem]);

  // 鼠标离开
  const handleMouseLeave = useCallback(() => {
    clearTimers();
    if (alertItem) return; // 提醒显示期间不自动收起
    if (state === "maximal") {
      collapseTimerRef.current = window.setTimeout(() => {
        setState("medium");
        setCurrentPage(0);
      }, 3000);
    } else if (state === "medium") {
      collapseTimerRef.current = window.setTimeout(() => {
        setState("minimal");
      }, settings.collapseDelay);
    }
  }, [state, settings.collapseDelay, clearTimers, setState, setCurrentPage, alertItem]);

  // 滚轮翻页 / 状态切换
  /**
   * 从设置面板(maximal)回到展开态 —— 落在"进来之前那一页"。
   *
   * 以前是写死的 `setExpandedPage(0)`，所以在设置页上滚永远回到音乐页，
   * 用户原本看的通知页被丢掉。现在统一走 pages.ts 的回落规则。
   */
  const returnFromMaximal = useCallback(() => {
    // 从哪里来回哪里去。当前只有"展开态下滚"能进设置面板，所以实际都会回展开态；
    // medium 分支是为将来"悬浮态直接进设置面板"预留的正确行为，别删。
    if (maximalFromRef.current === "medium") {
      setCurrentPage(mediumPageOnReturn(lastMediumPageRef.current));
      setState("medium");
      return;
    }
    setExpandedPage(expandedPageOnReturn(lastExpandedPageRef.current));
    setCurrentPage(MEDIUM_MUSIC_INDEX);
    setState("expanded");
  }, [setState, setCurrentPage]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!settings.wheelEnabled) return;
      // 提醒显示期间不接受翻页/转场（用户反馈"弹出消息时可以在各种状态之间切换"）
      if (alertItem) return;

      const root = e.currentTarget as HTMLElement;
      const target = e.target as Element | null;
      // 滚轮落在页内可滚动区域（通知列表、设置面板）**且内容还能朝这个方向滚**时，
      // 把这次滚轮让给内容 —— 不翻页、也不 preventDefault。
      // 内容已滚到头就往下走状态机（于是"设置面板滚到顶再上滚"能回到展开态）。
      //
      // 注意：这里**不能**因为"落在可滚动区域内"就无条件 return。
      // 之前多了一道 `if (isInsideScrollable(...)) return;`，导致设置面板滚到顶后
      // 仍然被拦下，用户永远无法从 maximal 滚回 expanded —— 这就是该 bug 的根因。
      if (canScrollableAncestorScroll(target, e.deltaY, root)) return;

      const dir = e.deltaY > 0 ? 1 : -1;
      let acted = true;

      if (state === "minimal") {
        // 只能下滚进 medium；上滚不做事（允许浏览器默认行为）
        if (dir < 0) acted = false;
        else setState("medium");
      } else if (state === "medium") {
        if (dir > 0) {
          if (isLastMediumPage(currentPage)) {
            // 悬浮态最后一页（音乐）继续下滚 → 进展开态。记住来源页以便回滚。
            lastMediumPageRef.current = currentPage;
            setState("expanded");
          } else {
            setCurrentPage(currentPage + 1);
          }
        } else {
          if (currentPage <= 0) {
            setCurrentPage(MEDIUM_PAGES.length - 1);
          } else {
            setCurrentPage(currentPage - 1);
          }
        }
      } else if (state === "expanded") {
        if (dir > 0) {
          if (isLastExpandedPage(expandedPage)) {
            lastExpandedPageRef.current = expandedPage;
            setCurrentPage(SETTINGS_PAGE_INDEX);
            setState("maximal");
          } else {
            setExpandedPage(expandedPage + 1);
          }
        } else {
          if (expandedPage > 0) {
            setExpandedPage(expandedPage - 1);
          } else {
            setCurrentPage(mediumPageOnReturn(lastMediumPageRef.current));
            setState("medium");
          }
        }
      } else if (state === "maximal") {
        // 上滑 → 展开态（回到进来之前那一页）
        if (dir < 0) returnFromMaximal();
        else acted = false;
      }

      // 只在真的发生了翻页/转场时吃掉滚动，否则把控制权还给页面（设置面板等要能滚）
      if (acted) e.preventDefault();
    },
    [state, currentPage, expandedPage, settings.wheelEnabled, setState, setCurrentPage, returnFromMaximal, alertItem]
  );

  // Esc 返回上一级（与滚轮回退同口径）
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 设置面板要能正常输入/回车；提醒期间不接受方向键翻页
      if (alertItem) return;
      if (e.key === "Escape") {
        if (state === "maximal") {
          returnFromMaximal();
        } else if (state === "expanded") {
          setCurrentPage(mediumPageOnReturn(lastMediumPageRef.current));
          setState("medium");
        }
        return;
      }

      // 方向键翻页（与滚轮同口径）；maximal(设置面板) 不响应，避免影响表单
      const next = e.key === "ArrowDown" || e.key === "ArrowRight";
      const prev = e.key === "ArrowUp" || e.key === "ArrowLeft";
      if (!next && !prev) return;

      if (state === "expanded") {
        e.preventDefault();
        if (next && expandedPage < EXPANDED_PAGES.length - 1) setExpandedPage(expandedPage + 1);
        else if (prev && expandedPage > 0) setExpandedPage(expandedPage - 1);
        else if (prev) {
          setCurrentPage(mediumPageOnReturn(lastMediumPageRef.current));
          setState("medium");
        }
      } else if (state === "medium") {
        e.preventDefault();
        if (next && currentPage < MEDIUM_PAGES.length - 1) setCurrentPage(currentPage + 1);
        else if (prev && currentPage > 0) setCurrentPage(currentPage - 1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, currentPage, expandedPage, setState, setCurrentPage, returnFromMaximal, alertItem]);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  /**
   * 全局新通知探测。
   *
   * `check_notifications` 只 stat 三个文件（微秒级），所以这里可以高频跑：
   * **1200ms**。这是"提醒延迟"的主要来源 —— 原本 3s 一轮，最坏就要等 3s 才弹。
   *
   * 不再因为"已在展开态"而让位：以前展开态会 return，此时若通知页先把指纹标记为
   * "已变化"，等用户滚回收起态时这里就探不到那次变化、提醒被吞掉。现在两个探测者
   * 都调同一个命令（谁先拿到 changed 谁处理），互相不会吞事件。
   */
  useEffect(() => {
    if (!settings.notificationsEnabled || !settings.notificationAlert) return;

    let cancelled = false;
    const seen = new Set<number>();
    let primed = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await invoke<{ changed: boolean }>("check_notifications");
        if (cancelled || !res?.changed) return;

        const batch = await fetchNotifications(settings.notificationMaxItems);
        if (cancelled) return;

        if (!primed) {
          // 基线：把当前已有的全部记为"已见"，不提醒
          batch.forEach((it) => seen.add(it.id));
          primed = true;
          return;
        }
        const fresh = batch.filter(
          (it) => !seen.has(it.id) && !isBlacklisted(it, settings.notificationBlacklist)
        );
        batch.forEach((it) => seen.add(it.id));
        // 一次来多条时只提醒最新那条，避免连环弹窗
        if (fresh.length > 0) showAlert(fresh[0]);
      } catch {
        /* 探测失败静默忽略，等下一轮 */
      }
    };

    const timer = window.setInterval(() => void poll(), 1200);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    settings.notificationsEnabled,
    settings.notificationAlert,
    settings.notificationMaxItems,
    settings.notificationBlacklist,
    showAlert,
  ]);

  /**
   * 收起提醒。
   *
   * 收起时要补两件事，否则会留下"鬼状态"：
   *  ① 提醒期间我们锁住了 hover 逻辑，若指针仍停在岛上（提醒因为悬停被顺延过，
   *     这是常见情况），要把"悬停进 medium"重新接上，不然岛会停在 minimal 不动；
   *  ② 同步窗口尺寸基准，避免用陈旧的尺寸做插值。
   */
  const dismissAlert = useCallback(() => {
    const stillHovering = alertHoverRef.current;
    alertHoverRef.current = false;
    setAlertItem(null);
    // 清掉上一条的实测高度：否则下一条提醒会先按旧高度弹、再跳一下
    setAlertHeight(null);
    if (stillHovering) {
      clearTimers();
      if (state === "minimal") {
        hoverTimerRef.current = window.setTimeout(() => {
          setState("medium");
        }, settings.hoverDelay);
      }
    }
  }, [state, settings.hoverDelay, clearTimers, setState]);

  /**
   * 提醒停留计时（以 5s 为底，用户可调）。
   *
   * 指针停在提醒上时不自动收起 —— 用户可能正在读；移开后重新计时。
   * 用 `alertHoverRef` 而不是 state，避免每次鼠标移动都重渲染。
   */
  useEffect(() => {
    if (!alertItem) return;
    const delay = Math.max(2000, settings.notificationAlertMs);
    const schedule = () => {
      if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
      alertTimerRef.current = window.setTimeout(() => {
        // 悬停中 → 顺延，等移开后由 onMouseLeave 重新安排
        if (alertHoverRef.current) {
          schedule();
          return;
        }
        alertTimerRef.current = null;
        dismissAlert();
      }, delay);
    };
    schedule();
    return () => {
      if (alertTimerRef.current !== null) {
        window.clearTimeout(alertTimerRef.current);
        alertTimerRef.current = null;
      }
    };
  }, [alertItem, settings.notificationAlertMs, dismissAlert]);

  /** 鼠标离开提醒层：若正在顺延中，重新计时 */
  const handleAlertMouseLeave = useCallback(() => {
    alertHoverRef.current = false;
    if (!alertItem) return;
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
    const delay = Math.max(2000, settings.notificationAlertMs);
    alertTimerRef.current = window.setTimeout(() => {
      alertTimerRef.current = null;
      dismissAlert();
    }, delay);
  }, [alertItem, settings.notificationAlertMs, dismissAlert]);

  const floating = settings.style === "floating";
  const theme = THEME_PRESETS[settings.theme];

  // CSS 变量：让 index.css 与各页面自适应主题。
  // 注意 --island-border 必须在这里注入：:root 里的默认值是深色主题的白色描边，
  // 浅色主题下如果不覆盖，页面的发丝分隔线（日历英雄块、通知页 header、下拉浮层）
  // 在近白底上几乎看不见。
  const cssVars: React.CSSProperties = (
    settings.theme === "dark"
      ? {
          "--island-text": "#ffffff",
          "--island-text-muted": "rgba(255,255,255,0.65)",
          "--island-border": "rgba(255,255,255,0.12)",
          "--sidebar-tab-hover": "rgba(255,255,255,0.08)",
          "--sidebar-tab-active": "rgba(255,255,255,0.14)",
          "--sidebar-tab-active-hover": "rgba(255,255,255,0.2)",
          "--slider-track": "rgba(255,255,255,0.15)",
          "--slider-thumb-bg": "#ffffff",
          "--switch-track": "rgba(255,255,255,0.2)",
          "--switch-thumb-bg": "#ffffff",
          // 通用语义面/状态色（各页面别再就地写 rgba(255,255,255,x)）
          "--surface-1": "rgba(255,255,255,0.05)",
          "--surface-2": "rgba(255,255,255,0.08)",
          "--surface-3": "rgba(255,255,255,0.14)",
          "--input-bg": "rgba(0,0,0,0.2)",
          "--accent-glow": "rgba(255,255,255,0.45)",
          "--state-info": "#5aa9ff",
          // 浮层（年月下拉 / 悬浮提示）：深色主题用比岛体略亮的深灰
          "--popover-bg": "rgba(30,32,38,0.98)",
          "--popover-shadow": "0 10px 26px rgba(0,0,0,0.55)",
          // 日历语义色（深色底上用亮色）
          "--cal-holiday": "#ff7a7a",
          "--cal-festival": "#5aa9ff",
          "--cal-rest-cell": "rgba(255,122,122,0.10)",
          "--cal-rest-pill-bg": "rgba(255,122,122,0.16)",
          "--cal-rest-pill-fg": "#ff9a9a",
          "--cal-work-pill-bg": "rgba(255,207,107,0.16)",
          "--cal-work-pill-fg": "#ffcf6b",
        }
      : {
          "--island-text": "#1d1d1f",
          "--island-text-muted": "rgba(29,29,31,0.55)",
          "--island-border": "rgba(0,0,0,0.12)",
          "--sidebar-tab-hover": "rgba(0,0,0,0.06)",
          "--sidebar-tab-active": "rgba(0,0,0,0.1)",
          "--sidebar-tab-active-hover": "rgba(0,0,0,0.14)",
          "--slider-track": "rgba(0,0,0,0.12)",
          "--slider-thumb-bg": "#ffffff",
          "--switch-track": "rgba(0,0,0,0.15)",
          "--switch-thumb-bg": "#ffffff",
          "--surface-1": "rgba(0,0,0,0.04)",
          "--surface-2": "rgba(0,0,0,0.06)",
          "--surface-3": "rgba(0,0,0,0.10)",
          "--input-bg": "rgba(0,0,0,0.05)",
          "--accent-glow": "rgba(0,0,0,0.22)",
          "--state-info": "#0a6cff",
          "--popover-bg": "rgba(252,252,253,0.98)",
          "--popover-shadow": "0 10px 26px rgba(0,0,0,0.18)",
          // 日历语义色（浅色底上要用更深的同色系，浅红/浅蓝在近白底上会糊成一片）
          "--cal-holiday": "#d70015",
          "--cal-festival": "#0a6cff",
          "--cal-rest-cell": "rgba(255,59,48,0.12)",
          "--cal-rest-pill-bg": "rgba(255,59,48,0.12)",
          "--cal-rest-pill-fg": "#d70015",
          "--cal-work-pill-bg": "rgba(255,159,10,0.18)",
          "--cal-work-pill-fg": "#a15c00",
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
  /**
   * 布局上是否按"展开态"处理 —— 展开态、最大态（设置页）**或**正在弹新通知提醒。
   *
   * 三者共用同一套几何：外层窗口四周留 SHADOW_PAD 留白、岛体内缩 3px。
   * 最大态跟着展开态走，是为了让设置页与展开页**逐像素同尺寸**（见 MAXIMAL_W/H 注释），
   * 进出设置页时窗口不再缩放。
   *
   * 提醒借用展开态的留白/阴影/圆角（SHADOW_PAD 那套规则必须一起用，否则阴影会被
   * 窗口边界裁成硬边，就是之前那个"长方形黑边"），但 `state` 与用户页签都不变。
   */
  const isExpandedLayout = isExpanded || state === "maximal" || alertItem !== null;

  /**
   * 某个内容层当前是否应该可见。
   *
   * 弹出提醒时**所有常规层都要让位** —— 提醒层是 `inset:0` 的整块覆盖，而这些层是
   * 半透明玻璃，底下那层如果还亮着就会透出来（用户看到"弹出消息时背景显示日期天气"）。
   * 这里也顺手把 pointerEvents 关掉，避免隔着提醒层点到下面的按钮。
   */
  const layerVisible = (s: IslandState) => alertItem === null && state === s;
  const isDark = settings.theme === "dark";

  // 外层：填满 OS 窗口（展开态四周留出 SHADOW_PAD）
  // ⚠️ 这一层**必须完全透明**：任何背景色/渐变都会在圆角岛之外露出一圈矩形色块，
  //    即用户反复反馈的"长方形黑边"。深色底只能画在内层圆角岛上。
  const outerStyle: React.CSSProperties = {
    position: "absolute",
    // 展开态（含提醒）四周留出 SHADOW_PAD，让阴影有空间衰减
    inset: isExpandedLayout ? SHADOW_PAD : 0,
    borderRadius: getBorderRadius(size.h),
    overflow: isExpandedLayout ? "visible" : "hidden",
    background: "transparent",
    cursor: "pointer",
    transition:
      "border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1), overflow 0ms",
  };

  // 内层：岛主体
  // —— 四周内缩（内容不贴边）；展开态收紧到 3px
  // —— 贴边挂角（docked）时**上边零内缩**：岛体顶边必须与窗口顶边（= 屏幕顶边）齐平，
  //    否则顶部会残留一条 innerPad 的透明带（用户反馈的"最上的边与桌面有一定距离"）。
  //    左右/下边仍保留 2px，底部圆角那圈发丝描边才不贴屏幕外沿。
  // —— 四态统一：同一圈浅色发丝描边（var(--island-border)）
  const innerPad = isExpandedLayout ? 3 : 2;
  const innerStyle: React.CSSProperties = {
    position: "absolute",
    top: floating ? innerPad : 0,
    left: innerPad,
    right: innerPad,
    bottom: innerPad,
    borderRadius: getBorderRadius(size.h),
    backgroundColor: bgWithAlpha,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: `1px solid ${theme.border}`,
    // 阴影必须"装得下"：展开态只有 SHADOW_PAD(=12px) 的留白，若阴影扩散超出这个
    // 范围，就会被窗口的矩形边界裁断，在圆角岛外留下一圈矩形暗边——这正是用户
    // 反复反馈的"长方形黑边"的真因（不是描边，是阴影被窗口裁断）。
    // 因此展开态用紧凑阴影（约 8px 内衰减完），四态统一为
    // 「圆角 + 浅色发丝描边 + 柔和阴影 + 淡高光内边」。
    boxShadow: isDark
      ? isExpandedLayout
        ? [
            "0 2px 6px rgba(0, 0, 0, 0.35)",
            "inset 0 0 0 1px rgba(255, 255, 255, 0.05)",
          ].join(", ")
        : [
            "0 4px 16px rgba(0, 0, 0, 0.5)",
            "0 1px 2px rgba(0, 0, 0, 0.4)",
            // 原为 inset 0 0 0 2px rgba(0, 0, 0, 0.6)：2px 60% 黑内描边会在深色玻璃上
            // 形成一圈"黑框"（与展开态被移除的黑边同源）。改为极淡白色高光内边，
            // 与展开态及 minimal/medium/maximal 保持一致（圆角 + 柔和阴影 + 淡高光）。
            "inset 0 0 0 1px rgba(255, 255, 255, 0.05)",
          ].join(", ")
      : isExpandedLayout
        ? [
            "0 2px 6px rgba(0, 0, 0, 0.10)",
            "inset 0 0 0 1px rgba(0, 0, 0, 0.05)",
          ].join(", ")
        : [
            "0 4px 16px rgba(0, 0, 0, 0.12)",
            "0 1px 2px rgba(0, 0, 0, 0.08)",
            // 同上：原 2px 黑内描边改为极淡内边（浅色主题）
            "inset 0 0 0 1px rgba(0, 0, 0, 0.05)",
          ].join(", "),
    // 岛主体必须把内容裁到自己的圆角里：此前是 overflow:"visible"，而展开态的
    // 外层也是 visible，于是任何越界元素（日历左侧单日卡、封面光晕等）都会画到
    // 圆角岛之外——用户看到的"日历卡片左侧有内容超出窗口/被裁掉一角"就是这个。
    // 注意：boxShadow 是画在元素**外部**的，不受自身 overflow 影响，
    // 因此这里改成 hidden 不会吃掉那圈柔和阴影（四态仍统一为圆角+发丝描边+阴影）。
    overflow: "hidden",
    transition:
      "border-radius 280ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 180ms ease, border-color 180ms ease",
  };

  return (
    <div
      style={{ ...outerStyle, ...cssVars }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onWheelCapture={handleWheel as unknown as React.WheelEventHandler<HTMLDivElement>}
    >
      {/* 原先此处渲染 SVG 呼吸律动边框（ExpandedBorder）——它就是用户反复看到的
          "长方形淡黑边框"：该 <rect> 缺少 viewBox，width/height="99" 被当作 99px
          像素绘制（而非 99% 画布），低透明度的彩色描边叠在深色底上看起来发黑，
          并且只在展开态渲染（与用户"只有展开态有"的现象完全吻合）。
          按用户要求"看起来像窗口的阴影像其他状态一样"，移除该装饰边框。 */}

      <div style={innerStyle}>
        {/* 统一的悬浮提示层：控件的 title 全部换成 data-tip，由它绘制（四态共用）。
            zIndex 50 高于内容层与提醒层，四条边越界都会自动钳回岛体内。 */}
        <IslandTooltip />

        {/* 四层内容同时 mounted，用 opacity + pointerEvents 切换可见性 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: layerVisible("minimal") ? 1 : 0,
            pointerEvents: layerVisible("minimal") ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <MinimalContent weatherData={weatherData} musicData={musicData} lyrics={lyrics} />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: layerVisible("medium") ? 1 : 0,
            pointerEvents: layerVisible("medium") ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <MediumContent page={currentPage} weatherData={weatherData} musicData={musicData} lyrics={lyrics} />
          {/* 悬浮态页码：侧面竖向排列，可点击跳页 */}
          <div
            style={{
              position: "absolute",
              right: 8,
              top: 0,
              bottom: 0,
              display: "flex",
              alignItems: "center",
              zIndex: 5,
            }}
          >
            <PageIndicator
              count={MEDIUM_PAGES.length}
              activeIndex={currentPage}
              orientation="vertical"
              onSelect={setCurrentPage}
            />
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: layerVisible("expanded") ? 1 : 0,
            pointerEvents: layerVisible("expanded") ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <ExpandedContent
            page={expandedPage}
            visible={isExpanded}
            musicData={musicData}
            lyrics={lyrics}
            onSelectPage={setExpandedPage}
          />
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: layerVisible("maximal") ? 1 : 0,
            pointerEvents: layerVisible("maximal") ? "auto" : "none",
            transition: "opacity 200ms ease",
            zIndex: 1,
          }}
        >
          <SettingsPanel />
        </div>

        {/* 新通知提醒层：最高 z-index，盖住当前态的内容（state 不变，收起即回原样） */}
        {alertItem !== null && (
          <div
            onMouseEnter={() => {
              alertHoverRef.current = true;
            }}
            onMouseLeave={handleAlertMouseLeave}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 8,
              // 淡入 + 轻微上移，呼应"岛从顶部展开"的动作
              animation: "alertIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
            }}
          >
            <NotificationAlert ref={alertMeasureRef} item={alertItem} />
          </div>
        )}
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
  lyrics,
}: {
  weatherData: WeatherData | null;
  musicData: MusicData | null;
  lyrics: LyricLine[];
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
  // 封面光晕色：与展开态/悬浮态同一来源（= 进度条/丝线用的那份封面主色）。
  // hook 必须放在下面的条件 return 之前（Hooks 规则）。
  const { accent } = useCoverAccent(musicData?.cover_url ?? null);

  // —— 有音乐时：封面 + 右侧两行（[歌名][歌手] / 当前歌词）+ 时间 ——
  if (hasActiveMusic) {
    const miniLyric = getCurrentLyric(lyrics, (musicData.position || 0) * 1000);
    return (
      <div className="w-full h-full flex items-center gap-2.5 px-4" style={{ color }}>
        {/* 真实封面 (无则 EQ 占位) */}
        <div
          className="relative shrink-0 rounded-md overflow-hidden flex items-center justify-center"
          style={{
            width: 28, height: 28,
            background: musicData.cover_url ? "transparent" : "linear-gradient(135deg, #f472b6, #60a5fa)",
            // 封面光晕（用户要求三态都加）：颜色 = 封面主色 = 悬浮/展开态进度条同源
            boxShadow: `0 0 0 1px ${accent}40, 0 0 12px 3px ${accent}59, 0 2px 6px rgba(0,0,0,0.3)`,
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

        {/* 右侧两行（用户指定）：第一行 [歌名][歌手] 横排，第二行 当前歌词。
            没有歌词时第二行退化成播放状态，保证两行骨架不变。 */}
        <div className="flex flex-col flex-1 min-w-0 leading-tight gap-[1px]">
          <div className="flex items-baseline gap-[6px] min-w-0">
            <span className="text-[11px] font-medium truncate">{musicData.title || "未知曲目"}</span>
            {musicData.artist && (
              <span
                className="text-[9px] truncate shrink-0 max-w-[45%]"
                style={{ color: muted }}
              >
                {musicData.artist}
              </span>
            )}
          </div>
          <span className="text-[9.5px] truncate" style={{ color: muted, opacity: 0.95 }}>
            {miniLyric?.text ?? (musicData.playing ? "♪ 正在播放" : "⏸ 已暂停")}
          </span>
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
    <div className="w-full h-full flex items-center justify-center gap-2 px-4 text-[12px] leading-none" style={{ color }}>
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

// ===== expanded 态 SVG 呼吸律动边框（已移除） =====
// 该组件是"长方形淡黑边框"的真凶：<svg> 没有 viewBox，导致 <rect width="99" height="99">
// 按 99px 像素绘制而非铺满画布；island-belt-static 动画又让它呼吸闪动。
// 用户明确要求展开态看起来像窗口阴影（与其它状态一致），故不再渲染，组件一并删除。

// ===== expanded 态内容（音乐 / 日历 / 通知 三页 + 底部页码指示器） =====
function ExpandedContent({
  page,
  visible,
  musicData,
  lyrics,
  onSelectPage,
}: {
  page: number;
  /** 展开态是否可见 —— 三页同时 mounted，通知页靠它 gate 住轮询（否则一直读盘） */
  visible: boolean;
  musicData: MusicData | null;
  lyrics: LyricLine[];
  onSelectPage: (index: number) => void;
}) {
  // 三页同时 mounted，用 class 做透明度 + 轻微位移过渡（与 medium 态同机制）
  const pages: { key: string; node: React.ReactNode }[] = [
    { key: "music", node: <MusicDetailView data={musicData} lyrics={lyrics} /> },
    { key: "calendar", node: <CalendarPage visible={visible} /> },
    { key: "notification", node: <NotificationPage visible={visible} /> },
  ];
  const safePage = Math.min(Math.max(page, 0), pages.length - 1);

  return (
    <div className="w-full h-full relative">
      {pages.map((p, i) => (
        <div
          key={p.key}
          className={`island-page ${i === safePage ? "island-page-active" : "island-page-inactive"}`}
          aria-hidden={i !== safePage}
        >
          {p.node}
        </div>
      ))}

      {/* 底部页码：全圆点，当前页为高亮圆点 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 3,
          display: "flex",
          justifyContent: "center",
          zIndex: 6,
        }}
      >
        <PageIndicator count={pages.length} activeIndex={safePage} onSelect={onSelectPage} />
      </div>
    </div>
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

  // 封面主色：三态共用同一个来源（hook）—— 光晕、丝线、播放键、进度条都是它，
  // 因此"封面周围的光晕颜色 = 进度条颜色"必定一致。
  const { accent: accentColor, accent2: accentColor2 } = useCoverAccent(data?.cover_url ?? null);

  if (!data?.active) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-[18px] py-[16px]" style={{ color }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
          <path d="M9 18V5l12-2v13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span className="text-[12px]" style={{ color: muted }}>
          {data?.diag ? `⚠ ${data.diag}` : "暂无活跃音乐"}
        </span>
      </div>
    );
  }

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    // 与播放器一致：对秒数截断（floor）
    const total = Math.floor(s);
    const m = Math.floor(total / 60);
    const sec = (total % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  // timeline 为 0 时用模拟进度；duration 也为 0 时不显示百分比
  const hasRealDuration = data.duration > 0;
  const progress = hasRealDuration
    ? Math.min((data.position / data.duration) * 100, 100)
    : 0;
  // 色条与游标圆点共用同一个百分比：没有真实时长时给 2% 的"起步宽度"，
  // 让 0:00 也能看出这是一条进度轨道（原实现只给色条、游标会停在 0 处）。
  const progressPct = Math.min(Math.max(progress, hasRealDuration ? 0 : 2), 100);

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

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ color }}>
      {/* 背景：3 条"丝状"音频可视化铺满岛体（用户要求 2~4 条）。
          都关掉镜像线、只留细线 + 低透明度；相位与波幅各不相同，
          避免一眼看出是同一张图复制三份。封面不透明，左栏那部分自然被盖住。 */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: "4%", height: "30%" }}>
          <AudioWaveLine
            color={accentColor} color2={accentColor2} playing={!!data.playing}
            amplitude={0.95} phase={0} thickness={0.9} opacityScale={0.55} mirror={false}
          />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: "36%", height: "30%" }}>
          <AudioWaveLine
            color={accentColor} color2={accentColor2} playing={!!data.playing}
            amplitude={1.2} phase={1.9} thickness={0.75} opacityScale={0.42} mirror={false}
          />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: "68%", height: "30%" }}>
          <AudioWaveLine
            color={accentColor} color2={accentColor2} playing={!!data.playing}
            amplitude={0.7} phase={3.4} thickness={1} opacityScale={0.34} mirror={false}
          />
        </div>
      </div>

      {/* 内容层（用户要求的新布局）：
          左栏 = 封面（媒体来源压在封面左下角）+ 封面下方的控件
          右栏 = 顶部 [歌名][歌手] 横向排列 → 中间歌词 → 底部进度条 + 时间
          四周留 16~18px，任何元素都不贴岛体边缘。 */}
      <div
        className="w-full h-full relative flex flex-row gap-[20px] px-[18px] pt-[16px] pb-[16px]"
        style={{ zIndex: 1 }}
      >
        {/* 左栏：封面在上（媒体来源压在封面左下角）；控件贴栏底 —— 水平居中于封面、
            垂直与右栏进度条落在同一条水平线上（用户要求）。 */}
        <div className="shrink-0 flex flex-col" style={{ width: 170 }}>
          {/* 封面 = 这一页唯一的重心，与折线同源的光晕 */}
          <div
            className="relative shrink-0 overflow-hidden"
            style={{
              width: 170,
              height: 170,
              borderRadius: 16,
              background: data.cover_url ? "transparent" : "var(--surface-1)",
              border: "1px solid var(--island-border)",
              boxShadow: `
                0 0 0 1px ${accentColor}30,
                0 0 30px 6px ${accentColor}4d,
                0 10px 26px rgba(0,0,0,0.45)
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
                <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
                </svg>
              </div>
            )}

            {/* 媒体来源：压在封面左下角（用户要求）。深色半透明底 + 发丝边，
                不管封面明暗都读得清；左侧圆点跟随播放状态。 */}
            {data.app_name && (
              <span
                className="absolute flex items-center gap-[5px] max-w-[calc(100%-20px)]"
                style={{
                  left: 10,
                  bottom: 10,
                  padding: "3px 8px",
                  borderRadius: 6,
                  fontSize: 9.5,
                  letterSpacing: 0.2,
                  background: "rgba(0,0,0,0.45)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  color: "rgba(255,255,255,0.92)",
                }}
              >
                <i
                  style={{
                    width: 5, height: 5, borderRadius: "50%", flex: "0 0 auto",
                    background: data.playing ? "#4ade80" : "rgba(210,210,210,0.55)",
                  }}
                />
                <span className="truncate">{data.app_name}</span>
              </span>
            )}
          </div>

          {/* 控件：封面下方、贴栏底。justify-center = 与封面共用一条垂直中线（水平居中）；
              marginTop:auto + marginBottom:2px 把它的垂直中心压到右栏进度条的中心线上
              （进度条块高 23px、条本身中心距栏底 20.5px，控件高 38px → 底部留 2px）。 */}
          <div
            className="flex items-center justify-center gap-[6px]"
            style={{ marginTop: "auto", marginBottom: 2 }}
          >
            <button
              onClick={handlePrev}
              aria-label="上一首"
              className="flex items-center justify-center p-1.5 hover:opacity-100 hover:scale-110 active:scale-95 transition-all cursor-pointer"
              style={{ background: "none", border: "none", color: "var(--island-text)", opacity: 0.85 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button
              onClick={handlePlayPause}
              aria-label={data.playing ? "暂停" : "播放"}
              className="flex items-center justify-center rounded-full shrink-0 hover:scale-105 active:scale-95 transition-all cursor-pointer"
              style={{
                width: 38, height: 38,
                background: "var(--surface-2)",
                border: `1px solid ${accentColor}70`,
                boxShadow: `0 0 16px 2px ${accentColor}59`,
                color: "var(--island-text)",
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
              aria-label="下一首"
              className="flex items-center justify-center p-1.5 hover:opacity-100 hover:scale-110 active:scale-95 transition-all cursor-pointer"
              style={{ background: "none", border: "none", color: "var(--island-text)", opacity: 0.85 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>
        </div>

        {/* 右栏：顶部 [歌名][歌手] 横排 → 中间歌词（flex-1 垂直居中）→ 底部进度条 + 时间 */}
        <div className="relative flex-1 min-w-0 flex flex-col">
          {/* 顶部横排：歌名是焦点（大、半粗），歌手·专辑紧随其后并限宽，长名自动省略 */}
          <div className="flex items-baseline gap-[10px] min-w-0" style={{ zIndex: 1 }}>
            <div className="text-[19px] font-semibold leading-tight truncate min-w-0">
              {data.title || "未知曲目"}
            </div>
            <div
              className="text-[11.5px] leading-tight truncate shrink-0"
              style={{ color: muted, maxWidth: "46%" }}
            >
              {data.artist || "未知艺术家"}
              {data.album ? ` · ${data.album}` : ""}
            </div>
          </div>
          <LyricsBlock lyrics={lyrics} positionMs={(data.position || 0) * 1000} playing={data.playing} />

          {/* 进度条 + 时间：时间紧贴条下（5px），"现在到哪了"一眼可读 */}
          <div className="relative mt-[12px]" style={{ zIndex: 1 }}>
            {/* 进度条：轨道与已播段都带封面同色光晕（与丝线、封面、播放键同源） */}
            <div
              className="w-full h-[5px] rounded-full relative"
              style={{ background: "var(--slider-track)", boxShadow: `0 0 10px 1px ${accentColor}40` }}
            >
              <div
                className="absolute left-0 top-0 bottom-0 rounded-full"
                style={{
                  width: `${progressPct}%`,
                  background: `linear-gradient(90deg, ${accentColor}, ${accentColor2})`,
                  boxShadow: `0 0 8px ${accentColor}80`,
                  transition: "width 0.3s linear",
                }}
              />
              <div
                className="absolute rounded-full"
                style={{
                  left: `${progressPct}%`,
                  top: "50%",
                  width: 9,
                  height: 9,
                  marginLeft: -4.5,
                  marginTop: -4.5,
                  background: "#ffffff",
                  boxShadow: "0 0 6px rgba(255,255,255,0.5)",
                  transition: "left 0.3s linear",
                }}
              />
            </div>
            <div
              className="flex justify-between mt-[5px]"
              style={{ fontSize: 10.5, color: muted, fontVariantNumeric: "tabular-nums" }}
            >
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

  // 无歌词 → 一行状态，但仍占据歌词区（保证有/无歌词时"歌名在顶、控制在底"的骨架不变）
  if (lyrics.length === 0) {
    return (
      <div
        className="flex-1 min-h-0 mt-[10px] flex items-center text-[11px]"
        style={{ color: "var(--island-text-muted)" }}
      >
        {playing ? "♪ 正在播放 · 等待歌词…" : "⏸ 已暂停 · 等待歌词…"}
      </div>
    );
  }

  // 多行歌词（用户要求）：当前行上下各两行、共 5 行；越远的行越小越淡，
  // 当前行最大最亮 —— 不用滚动就能看出"唱到哪了"。
  const cur = currentIdx ?? 0;
  const startIdx = Math.max(0, cur - 2);
  const endIdx = Math.min(lyrics.length, startIdx + 5);
  const nearby = lyrics.slice(startIdx, endIdx);

  return (
    // 歌词左对齐、占据标题与进度条之间的弹性区并垂直居中：
    // 与左侧封面构成"图 + 文"的整块阅读区（原实现是居中对齐，与封面的左轴打架）。
    <div className="flex-1 min-h-0 mt-[10px] flex flex-col justify-center gap-[5px] min-w-0">
      {nearby.map((line, i) => {
        const dist = Math.abs(startIdx + i - cur);
        const isCurrent = dist === 0;
        return (
          <div
            key={`${startIdx + i}-${line.time_ms}`}
            className="truncate max-w-full"
            style={{
              fontSize: isCurrent ? 13 : 11,
              fontWeight: isCurrent ? 500 : 400,
              color: "var(--island-text)",
              opacity: isCurrent ? 1 : dist === 1 ? 0.42 : 0.24,
              transition: "color 200ms ease, font-size 200ms ease, opacity 200ms ease",
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
