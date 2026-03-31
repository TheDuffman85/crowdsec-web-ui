import { getHubUrl } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Badge } from "./ui/Badge";

interface ScenarioNameProps {
    name?: string | null;
    showLink?: boolean;
    className?: string;
    simulated?: boolean;
}

export function ScenarioName({ name, showLink = false, className = "", simulated = false }: ScenarioNameProps) {
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
        <div className={`flex flex-col items-start leading-tight min-w-0 ${className}`}>
            {namespace && <span className="text-xs text-gray-500 font-normal leading-none">{namespace}</span>}
            <div className="flex items-center gap-1 min-w-0 w-full">
                <span className="font-medium truncate text-gray-900 dark:text-gray-200 text-sm leading-tight min-w-0">{shortName}</span>
                {simulated && (
                    <Badge variant="warning" className="flex-shrink-0">
                        Simulation
                    </Badge>
                )}
                {showLink && hubUrl && (
                    <a
                        href={hubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors flex-shrink-0"
                        title="View on CrowdSec Hub"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <ExternalLink size={14} />
                    </a>
                )}
            </div>
        </div>
    );
}
