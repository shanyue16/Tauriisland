/**
 * 开发阶段开关（只在这里改，不进设置页、不写 settings.json）。
 *
 * 为什么放代码常量而不是 tauri.conf.json：
 * tauri.conf.json 改了要重编 Rust 并重启「启动.bat」，而这个开关只影响前端行为，
 * 放在 TS 里改完存盘就是一次 Vite 热更新（若没生效按 Ctrl+R 重载窗口）。
 * 所有开关都以 `import.meta.env.DEV` 为前置条件 —— 打包后的正式版一律走默认行为，
 * 不存在「用户装完发现右键菜单被吞了」的可能。
 */

export interface DevOptions {
  /**
   * true  = 屏蔽 WebView2 自带的浏览器右键菜单（刷新 / 另存为 / 检查元素 / 打印…）
   * false = 保留（默认行为，方便随时「检查元素」）
   *
   * 屏蔽后窗口内右键不再冒出浏览器菜单（输入框里也没有「粘贴」菜单），
   * 想恢复就把这里改回 false。
   */
  blockBrowserContextMenu: boolean;
}

export const DEV_OPTIONS: DevOptions = {
  blockBrowserContextMenu: true,
};

/**
 * 在 `main.tsx` 里挂载一次。用 capture 阶段拦下，确保任何子元素的右键都拦得住；
 * 只拦 contextmenu，不影响左键、拖拽、文本选择。
 */
export function installDevGuards(): void {
  if (!import.meta.env.DEV) return;

  if (DEV_OPTIONS.blockBrowserContextMenu) {
    window.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
      },
      { capture: true }
    );
  }
}
