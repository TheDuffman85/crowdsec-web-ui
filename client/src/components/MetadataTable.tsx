import type { DisplayMetadataEntry } from '../lib/alertMetadata';

interface MetadataTableProps {
    entries: DisplayMetadataEntry[];
}

export function MetadataTable({ entries }: MetadataTableProps) {
    return (
        <div className="bg-white dark:bg-gray-950 rounded border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
            {entries.map((entry, index) => (
                <div key={`${entry.key}-${index}`} className="grid grid-cols-[minmax(100px,auto)_1fr] gap-3 px-3 py-1.5 text-xs">
                    <span className="text-gray-500 font-medium break-all">{entry.key}</span>
                    <span className="font-mono break-all text-gray-700 dark:text-gray-300">
                        {entry.formattedValue}
                    </span>
                </div>
            ))}
        </div>
    );
}
