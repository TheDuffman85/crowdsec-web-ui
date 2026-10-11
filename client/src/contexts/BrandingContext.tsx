import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BrandingContext, type BrandingContextValue } from "./branding-context";
import {
  applyDocumentBranding,
  fetchBranding,
  getInitialBranding,
  type PublicBranding,
} from "../lib/branding";

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<PublicBranding>(getInitialBranding);

  const refreshBranding = useCallback(async () => {
    setBranding(await fetchBranding());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchBranding()
      .then((nextBranding) => {
        if (!cancelled) setBranding(nextBranding);
      })
      .catch(() => {
        // Keep the injected or default branding when the request fails.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyDocumentBranding(branding);
  }, [branding]);

  const value = useMemo<BrandingContextValue>(
    () => ({ ...branding, setBranding, refreshBranding }),
    [branding, refreshBranding],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}
