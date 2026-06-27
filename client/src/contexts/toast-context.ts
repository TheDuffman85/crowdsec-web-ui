import { createContext } from "react";

export type ToastType = "success" | "danger" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

export interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType, durationMs?: number | null) => string;
  removeToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
