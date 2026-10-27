import type { PropsWithChildren } from 'react';
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps extends PropsWithChildren {
    isOpen: boolean;
    onClose: () => void;
    title?: string | null;
    maxWidth?: string;
    showCloseButton?: boolean;
}

// Open modals in opening order, so Escape only closes the topmost one.
const openModals: object[] = [];

export function Modal({ isOpen, onClose, title, children, maxWidth = "max-w-md", showCloseButton = true }: ModalProps) {
    // Pressing inside the dialog and releasing over the backdrop (for example
    // while selecting text in an input) dispatches the click on the backdrop,
    // so the backdrop click only closes when the press also started on it.
    const pressStartedOnBackdrop = useRef<boolean | null>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        if (!isOpen) return;
        const modal = {};
        openModals.push(modal);

        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
            if (openModals[openModals.length - 1] !== modal) return;
            event.preventDefault();
            onCloseRef.current();
        };
        // Listening on window runs after document listeners, so popovers inside
        // the dialog can handle Escape first by calling preventDefault.
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("keydown", closeOnEscape);
            openModals.splice(openModals.indexOf(modal), 1);
        };
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [isOpen]);

    if (!isOpen) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onPointerDown={(event) => {
                pressStartedOnBackdrop.current = event.target === event.currentTarget;
            }}
            onClick={() => {
                const pressStartedInsideDialog = pressStartedOnBackdrop.current === false;
                pressStartedOnBackdrop.current = null;
                if (!pressStartedInsideDialog) onClose();
            }}
        >
            <div
                className={`bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full ${maxWidth} flex flex-col max-h-[90vh]`}
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={title || 'Dialog'}
            >
                {/* Header */}
                {(title || showCloseButton) && (
                    <div className="flex justify-between items-center p-6 border-b border-gray-100 dark:border-gray-700 shrink-0">
                        {title && (
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                                {title}
                            </h3>
                        )}
                        {showCloseButton && (
                            <button
                                onClick={onClose}
                                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-500 dark:text-gray-400 ml-auto"
                            >
                                <X size={20} />
                            </button>
                        )}
                    </div>
                )}

                {/* Content */}
                <div className="overflow-y-auto p-6 [scrollbar-gutter:stable]">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
}
