/**
 * 设置页的开关行（label 在左，`.switch` 在右）。
 *
 * 交互/高级/监控三个分区各写了一份一模一样的（连 className 都一样），
 * 唯一差别是行高：交互分区密度更高（py-1），其余用 py-1.5。
 *
 * 注意：这是**设置页**的开关，岛内日程编辑器里的 `Switch` 是另一套视觉（26×15 带 knob），
 * 两者不要合并。
 */
export default function Toggle({
  label,
  value,
  onChange,
  dense = false,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** 更紧凑的行高（交互分区用） */
  dense?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${dense ? "py-1" : "py-1.5"}`}>
      <span className="text-[11px] opacity-80">{label}</span>
      <div
        className={`switch${value ? " active" : ""}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}
