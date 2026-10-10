export default function About() {
  return (
    <div className="space-y-4">
      <h3 className="text-[13px] font-semibold opacity-90">关于</h3>

      <div className="flex flex-col items-center py-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
          style={{ background: "var(--surface-2)" }}
        >
          <span className="text-2xl">🏝️</span>
        </div>
        <div className="text-[14px] font-semibold">Tauriisland</div>
        <div className="text-[11px] opacity-50 mt-1">Windows 灵动岛</div>
        <div className="text-[10px] opacity-40 mt-1">版本 0.1.0</div>
      </div>

      <div
        className="rounded-lg p-3 text-[11px] opacity-60 leading-relaxed"
        style={{ background: "var(--surface-1)" }}
      >
        一个运行在 Windows 桌面顶部的灵动岛应用，参考 Apple Dynamic Island
        设计，提供悬浮胶囊和贴边挂角两种形态，聚合时间、通知、音乐播放、系统状态等信息。
      </div>

      <div className="text-[10px] opacity-40 text-center">
        技术栈：Tauri 2 · React 19 · TypeScript · Tailwind CSS 4
      </div>
    </div>
  );
}
