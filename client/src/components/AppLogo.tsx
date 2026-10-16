import { useState } from "react";
import { useBranding } from "../contexts/useBranding";
import { getDefaultLogoUrl } from "../lib/branding";
import { cn } from "../lib/utils";

/** Renders the first candidate that loads, falling back to the built-in logo. */
function LogoImage({ candidates, className, alt }: { candidates: Array<string | null>; className?: string; alt: string }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const src = candidates.find((url): url is string => Boolean(url) && !failedUrls.includes(url as string)) ?? getDefaultLogoUrl();

  return (
    <img
      src={src}
      alt={alt}
      className={cn("flex-shrink-0 object-contain", className)}
      onError={() => {
        if (candidates.includes(src)) setFailedUrls((urls) => [...urls, src]);
      }}
    />
  );
}

/**
 * The configured logo. With a dark mode logo, both images are rendered and CSS
 * picks one by theme, so switching themes never waits for an image to load.
 * `variant` pins one of them, e.g. for the settings preview.
 */
export function AppLogo({
  className,
  alt = "",
  variant = "auto",
}: {
  className?: string;
  alt?: string;
  variant?: "auto" | "default" | "dark";
}) {
  const { logoUrl, logoDarkUrl } = useBranding();

  if (variant === "default" || (variant === "auto" && !logoDarkUrl)) {
    return <LogoImage candidates={[logoUrl]} className={className} alt={alt} />;
  }
  if (variant === "dark") {
    return <LogoImage candidates={[logoDarkUrl, logoUrl]} className={className} alt={alt} />;
  }
  return (
    <>
      <LogoImage candidates={[logoUrl]} className={cn(className, "dark:hidden")} alt={alt} />
      <LogoImage candidates={[logoDarkUrl, logoUrl]} className={cn(className, "hidden dark:block")} alt={alt} />
    </>
  );
}
