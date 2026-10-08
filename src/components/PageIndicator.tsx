interface PageIndicatorProps {
  active: boolean;
  isSettings: boolean;
}

export default function PageIndicator({
  active,
  isSettings,
}: PageIndicatorProps) {
  return (
    <div
      style={{
        width: isSettings ? 12 : 4,
        height: 4,
        borderRadius: 2,
        background: active
          ? "rgba(255,255,255,0.85)"
          : "rgba(255,255,255,0.25)",
        transition: "all 0.2s ease",
      }}
    />
  );
}
