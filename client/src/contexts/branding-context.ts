import { createContext } from "react";
import { DEFAULT_BRANDING, type PublicBranding } from "../lib/branding";

export interface BrandingContextValue extends PublicBranding {
  setBranding: (branding: PublicBranding) => void;
  refreshBranding: () => Promise<void>;
}

export const BrandingContext = createContext<BrandingContextValue>({
  ...DEFAULT_BRANDING,
  setBranding: () => undefined,
  refreshBranding: async () => undefined,
});
