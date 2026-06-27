import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ToastContext, type Toast, type ToastType } from "./toast-context";

let fallbackToastIdCounter = 0;

function createToastId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackToastIdCounter += 1;
  return `${Date.now().toString(36)}-${fallbackToastIdCounter.toString(36)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    const nextToasts = toastsRef.current.filter((toast) => toast.id !== id);
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", durationMs?: number | null) => {
      const id = createToastId();
      const nextToasts = [...toastsRef.current, { id, message, type }];
      toastsRef.current = nextToasts;
      setToasts(nextToasts);

      const duration = durationMs === undefined ? (type === "danger" ? 15000 : 5000) : durationMs;
      if (duration !== null) {
        window.setTimeout(() => removeToast(id), duration);
      }

      return id;
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}
