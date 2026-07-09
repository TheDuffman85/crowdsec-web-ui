interface CountryFlagProps {
  code?: string | null;
  className?: string;
}

export function CountryFlag({ code, className = '' }: CountryFlagProps) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  const flag = String.fromCodePoint(
    ...Array.from(normalized).map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );

  return (
    <span
      aria-label={normalized}
      className={`inline-flex h-4 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-sm text-base leading-none ${className}`}
      role="img"
      title={normalized}
    >
      {flag}
    </span>
  );
}
