import { useContext } from "react";
import { ToastContext } from "./toast-context";

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

export function useOptionalToast() {
  return useContext(ToastContext);
}
