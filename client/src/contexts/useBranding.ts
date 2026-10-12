import { useContext } from "react";
import { BrandingContext } from "./branding-context";

export function useBranding() {
  return useContext(BrandingContext);
}
