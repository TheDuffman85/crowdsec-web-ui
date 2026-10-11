import { useState } from "react";
import { useBranding } from "../contexts/useBranding";
import { getDefaultLogoUrl } from "../lib/branding";
import { cn } from "../lib/utils";

export function AppLogo({ className, alt = "" }: { className?: string; alt?: string }) {
  const { logoUrl } = useBranding();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = logoUrl && failedUrl !== logoUrl ? logoUrl : getDefaultLogoUrl();

  return (
    <img
      src={src}
      alt={alt}
      className={cn("flex-shrink-0 object-contain", className)}
      onError={() => {
        if (logoUrl && src === logoUrl) setFailedUrl(logoUrl);
      }}
    />
  );
}
