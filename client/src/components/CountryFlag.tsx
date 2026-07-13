interface CountryFlagProps {
  code?: string | null;
  className?: string;
}

export function CountryFlag({ code, className = '' }: CountryFlagProps) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  return (
    <span
      aria-label={normalized}
      className={`fi fi-${normalized.toLowerCase()} flex-shrink-0 overflow-hidden rounded-sm ${className}`}
      role="img"
      title={normalized}
    />
  );
}
