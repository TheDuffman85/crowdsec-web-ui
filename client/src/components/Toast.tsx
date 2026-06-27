import { X } from "lucide-react";
import type { ToastType } from "../contexts/toast-context";
import { useI18n } from "../lib/i18n";

const typeStyles: Record<ToastType, string> = {
  success: "bg-green-600 text-white",
  danger: "bg-red-600 text-white",
  info: "bg-blue-600 text-white",
};

export function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: ToastType;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className={`toast-enter flex items-start justify-between gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ${typeStyles[type]}`}>
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded p-0.5 opacity-75 transition-opacity hover:opacity-100"
        aria-label={t("components.toast.closeNotification")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
