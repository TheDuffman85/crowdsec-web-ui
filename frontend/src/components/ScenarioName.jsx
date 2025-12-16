import { getHubUrl } from "../lib/utils";
import { ExternalLink } from "lucide-react";

export function ScenarioName({ name, showLink = false, className = "" }) {
    if (!name) return null;

    // Split by first slash
    const firstSlashIndex = name.indexOf('/');
    let namespace = "";
    let shortName = name;

    if (firstSlashIndex !== -1) {
        namespace = name.substring(0, firstSlashIndex); // exclude the slash
        shortName = name.substring(firstSlashIndex + 1);
    }

    const hubUrl = showLink ? getHubUrl(name) : null;

    return (
        <div className={`flex flex-col items-start leading-tight ${className}`}>
            {namespace && <span className="text-xs text-gray-500 font-normal leading-none">{namespace}</span>}
            <div className="flex items-center gap-1">
                <span className="font-medium truncate text-gray-900 dark:text-gray-200 text-sm leading-tight">{shortName}</span>
                {showLink && hubUrl && (
                    <a
                        href={hubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors flex-shrink-0"
                        title="View on CrowdSec Hub"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <ExternalLink size={14} />
                    </a>
                )}
            </div>
        </div>
    );
}
