const INSTANCE_COLOR_CLASSES = [
  'bg-blue-500',
  'bg-green-500',
  'bg-orange-500',
  'bg-purple-500',
  'bg-pink-500',
  'bg-cyan-500',
  'bg-amber-500',
  'bg-lime-500',
] as const;

interface InstanceIconProps {
  icon?: string;
  colorIndex: number;
}

export function InstanceIcon({ icon, colorIndex }: InstanceIconProps) {
  if (icon) {
    return (
      <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center leading-none" aria-hidden="true">
        {icon}
      </span>
    );
  }

  const normalizedIndex = ((colorIndex % INSTANCE_COLOR_CLASSES.length) + INSTANCE_COLOR_CLASSES.length)
    % INSTANCE_COLOR_CLASSES.length;

  return (
    <span
      className={`instance-color-icon inline-block h-4 w-4 shrink-0 rounded-[2px] ${INSTANCE_COLOR_CLASSES[normalizedIndex]}`}
      aria-hidden="true"
    />
  );
}
