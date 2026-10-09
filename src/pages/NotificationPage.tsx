/**
 * 通知页（骨架/空态）。
 * 后端读取与发送尚未接入 —— 本页只做优雅空态，不触碰 Rust/服务层。
 */
export default function NotificationPage() {
  const color = "var(--island-text)";
  const muted = "var(--island-text-muted)";

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-2 px-[18px] py-[14px]"
      style={{ color }}
    >
      <div
        className="flex items-center justify-center rounded-full shrink-0"
        style={{
          width: 40,
          height: 40,
          background: "rgba(255,255,255,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6 }}>
          <path
            d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M13.7 21a2 2 0 0 1-3.4 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="text-[12px] font-medium">通知读取开发中</div>
      <div className="text-[10px] text-center leading-tight" style={{ color: muted }}>
        下一步接入系统通知的读取与发送
      </div>
    </div>
  );
}
