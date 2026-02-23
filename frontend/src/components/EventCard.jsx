import { Badge } from "./ui/Badge";
import { Collapsible } from "./ui/Collapsible";
import { getHubUrl } from "../lib/utils";
import { ExternalLink, Shield } from "lucide-react";

// Meta keys that get special styled rendering in the summary section
const STYLED_META_KEYS = new Set([
    'target_fqdn', 'target_host', 'target_uri', 'uri',
    'traefik_router_name', 'http_verb', 'http_path',
    'http_status', 'http_user_agent', 'service',
    'matched_zones', 'rule_name', 'appsec_action',
    'rule_ids', 'msg', 'message',
]);

// Excluded from display due to PII/GDPR concerns (per CrowdSec developer guidance)
const EXCLUDED_META_KEYS = new Set(['context']);

export function EventCard({ event, index }) {
    const getMeta = (key) => event.meta?.find(m => m.key === key)?.value;

    const isAppSecEvent = event.meta?.some(m =>
        m.key === 'matched_zones' || m.key === 'rule_name' || m.key === 'appsec_action'
    );

    // Known fields
    const ruleName = getMeta('rule_name');
    const matchedZones = getMeta('matched_zones');
    const ruleIds = getMeta('rule_ids');
    const message = getMeta('msg') || getMeta('message');
    const targetFqdn = getMeta('target_fqdn');
    const targetHost = getMeta('target_host');
    const targetUri = getMeta('target_uri') || getMeta('uri');
    const traefikRouter = getMeta('traefik_router_name');
    const httpVerb = getMeta('http_verb');
    const httpPath = getMeta('http_path');
    const httpStatus = getMeta('http_status');
    const httpUserAgent = getMeta('http_user_agent');
    const service = getMeta('service');

    // Additional meta fields not covered by styled rendering
    // Filter out entries with empty/null/undefined values
    const additionalMeta = event.meta?.filter(m =>
        !STYLED_META_KEYS.has(m.key) && !EXCLUDED_META_KEYS.has(m.key) && m.value != null && m.value !== ''
    ) || [];

    return (
        <div className={`flex gap-3 items-start p-3 rounded border text-sm ${isAppSecEvent
            ? 'bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-900/30'
            : 'bg-gray-50 dark:bg-gray-900/30 border-gray-100 dark:border-gray-800'
        }`}>
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 pt-0.5 shrink-0">#{index + 1}</span>
            <div className="flex-1 min-w-0">
                {/* AppSec Badge */}
                {isAppSecEvent && (
                    <div className="mb-2 flex items-center gap-2">
                        <Badge variant="danger" className="flex items-center gap-1">
                            <Shield size={12} />
                            AppSec / WAF
                        </Badge>
                    </div>
                )}

                <div className="space-y-2">
                {/* Timestamp and Service */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div>
                        <span className="text-gray-500">Timestamp:</span>{' '}
                        <span className="font-mono text-xs">{event.timestamp}</span>
                    </div>
                    {service && (
                        <div>
                            <span className="text-gray-500">Service:</span> {service}
                        </div>
                    )}
                </div>

                {/* Target FQDN/Host */}
                {(targetFqdn || targetHost) && (
                    <div>
                        <span className="text-gray-500">Target:</span>{' '}
                        <span className="font-mono text-xs">{targetFqdn || targetHost}</span>
                    </div>
                )}

                {/* Traefik Router */}
                {traefikRouter && (
                    <div>
                        <span className="text-gray-500">Router:</span>{' '}
                        <span className="font-mono text-xs">{traefikRouter}</span>
                    </div>
                )}

                {/* AppSec Rule Info */}
                {isAppSecEvent && ruleName && (
                    <div>
                        <span className="text-gray-500">Rule:</span>{' '}
                        {(() => {
                            const hubUrl = getHubUrl(ruleName);
                            return hubUrl ? (
                                <a
                                    href={hubUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-xs hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                >
                                    {ruleName}
                                    <ExternalLink size={10} />
                                </a>
                            ) : (
                                <span className="font-mono text-xs">{ruleName}</span>
                            );
                        })()}
                    </div>
                )}

                {/* AppSec Details */}
                {isAppSecEvent && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {matchedZones && (
                            <div>
                                <span className="text-gray-500">Matched Zone:</span>{' '}
                                <Badge variant="outline" className="ml-1">{matchedZones}</Badge>
                            </div>
                        )}
                        {ruleIds && (
                            <div>
                                <span className="text-gray-500">Rule ID:</span>{' '}
                                <span className="font-mono text-xs">{ruleIds}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Message/Description */}
                {isAppSecEvent && message && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 italic">
                        {message}
                    </div>
                )}

                {/* HTTP Request Details */}
                {(httpVerb || httpPath || targetUri) && (
                    <div className="font-mono text-xs break-all bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-800">
                        <span className="text-blue-600 dark:text-blue-400 font-bold">{httpVerb || 'GET'}</span>{' '}
                        {httpPath || targetUri || '/'}
                        {(httpStatus || httpUserAgent) && (
                            <div className="text-gray-400 mt-1">
                                {httpStatus && `Status: ${httpStatus}`}
                                {httpStatus && httpUserAgent && ' | '}
                                {httpUserAgent && `UA: ${httpUserAgent}`}
                            </div>
                        )}
                    </div>
                )}

                {/* Additional Metadata — collapsible generic key-value display */}
                {additionalMeta.length > 0 && (
                    <Collapsible
                        trigger={
                            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                Additional Metadata ({additionalMeta.length})
                            </span>
                        }
                        defaultOpen={false}
                    >
                        <div className="mt-1 bg-white dark:bg-gray-950 rounded border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
                            {additionalMeta.map((m, i) => (
                                <div key={i} className="grid grid-cols-[minmax(100px,auto)_1fr] gap-3 px-3 py-1.5 text-xs">
                                    <span className="text-gray-500 font-medium">{m.key}</span>
                                    <span className="font-mono break-all text-gray-700 dark:text-gray-300">
                                        {typeof m.value === 'object' ? JSON.stringify(m.value) : String(m.value)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </Collapsible>
                )}
            </div>
            </div>
        </div>
    );
}
