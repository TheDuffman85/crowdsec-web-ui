import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export function Collapsible({ trigger, children, defaultOpen = false, className }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div className={cn("", className)}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-1 w-full text-left cursor-pointer"
            >
                <ChevronRight
                    size={16}
                    className={cn(
                        "shrink-0 text-gray-400 transition-transform duration-150",
                        isOpen && "rotate-90"
                    )}
                />
                <div className="flex-1 min-w-0">{trigger}</div>
            </button>
            <div
                className={cn(
                    "grid transition-[grid-template-rows] duration-150 ease-out",
                    isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                )}
            >
                <div className="overflow-hidden">
                    {children}
                </div>
            </div>
        </div>
    );
}
