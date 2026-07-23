import { Badge } from "./ui/Badge";
import { Collapsible } from "./ui/Collapsible";
import { getHubUrl } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import type { AlertEvent, AlertMetaValue } from '../types';
import type { PropsWithChildren } from 'react';
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/dateTime";
import { formatMetaValue, getDisplayMetadata, isAppSecEvent } from '../lib/alertMetadata';
import { MetadataTable } from './MetadataTable';

interface EventCardProps {
    event: AlertEvent;
    index: number;
}

function EventDetailRow({ label, children }: PropsWithChildren<{ label: string }>) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(9rem,12rem)_1fr]">
            <dt className="px-3 py-1.5 text-xs font-semibold text-gray-500 break-all dark:text-gray-400">
                {label}
            </dt>
            <dd className="min-w-0 border-t border-gray-200 bg-white px-3 py-1.5 text-xs dark:border-gray-800 dark:bg-gray-950 sm:border-t-0 sm:border-l">
                {children}
            </dd>
        </div>
    );
}

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

export function EventCard({ event, index }: EventCardProps) {
    const { t } = useI18n();
    const { formatDateTime } = useDateTime();
    const getMeta = (key: string): AlertMetaValue | undefined => event.meta?.find((meta) => meta.key === key)?.value;

    const appSecEvent = isAppSecEvent(event);

    // Known fields
    const ruleName = formatMetaValue(getMeta('rule_name'));
    const matchedZones = formatMetaValue(getMeta('matched_zones'));
    const ruleIds = formatMetaValue(getMeta('rule_ids'));
    const message = formatMetaValue(getMeta('msg')) || formatMetaValue(getMeta('message'));
    const targetFqdn = formatMetaValue(getMeta('target_fqdn'));
    const targetHost = formatMetaValue(getMeta('target_host'));
    const targetUri = formatMetaValue(getMeta('target_uri')) || formatMetaValue(getMeta('uri'));
    const traefikRouter = formatMetaValue(getMeta('traefik_router_name'));
    const httpVerb = formatMetaValue(getMeta('http_verb'));
    const httpPath = formatMetaValue(getMeta('http_path'));
    const httpStatus = formatMetaValue(getMeta('http_status'));
    const httpUserAgent = formatMetaValue(getMeta('http_user_agent'));
    const service = formatMetaValue(getMeta('service'));
    const ruleHubUrl = ruleName ? getHubUrl(ruleName) : undefined;

    // Additional meta fields not covered by styled rendering
    // Filter out entries with empty/null/undefined values
    const additionalMeta = getDisplayMetadata(event.meta?.filter((meta) =>
        !STYLED_META_KEYS.has(meta.key) && !EXCLUDED_META_KEYS.has(meta.key) && meta.value != null && meta.value !== ''
    ));

    return (
        <div className="flex gap-3 items-start p-3 rounded border border-gray-100 bg-gray-50 text-sm dark:border-gray-800 dark:bg-gray-900/30">
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 pt-0.5 shrink-0">#{index + 1}</span>
            <div className="flex-1 min-w-0">
                <div className="space-y-2">
                {/* Event summary */}
                <dl className="overflow-hidden rounded border border-gray-100 bg-gray-50 divide-y divide-gray-100 dark:border-gray-800 dark:bg-gray-900/30 dark:divide-gray-800">
                    <EventDetailRow label={t('components.eventCard.timestamp')}>
                        <span className="font-mono">{event.timestamp ? formatDateTime(event.timestamp) : '-'}</span>
                    </EventDetailRow>
                    {service && (
                        <EventDetailRow label={t('components.eventCard.service')}>
                            <span className="font-mono break-all">{service}</span>
                        </EventDetailRow>
                    )}
                    {(targetFqdn || targetHost) && (
                        <EventDetailRow label={t('components.eventCard.target')}>
                            <span className="font-mono break-all">{targetFqdn || targetHost}</span>
                        </EventDetailRow>
                    )}
                    {traefikRouter && (
                        <EventDetailRow label={t('components.eventCard.router')}>
                            <span className="font-mono break-all">{traefikRouter}</span>
                        </EventDetailRow>
                    )}
                    {appSecEvent && ruleName && (
                        <EventDetailRow label={t('components.eventCard.rule')}>
                            {ruleHubUrl ? (
                                <a
                                    href={ruleHubUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-mono transition-colors hover:text-primary-600 dark:hover:text-primary-400"
                                >
                                    {ruleName}
                                    <ExternalLink size={10} />
                                </a>
                            ) : (
                                <span className="font-mono break-all">{ruleName}</span>
                            )}
                        </EventDetailRow>
                    )}
                    {appSecEvent && (
                        <>
                        {matchedZones && (
                            <EventDetailRow label={t('components.eventCard.matchedZone')}>
                                <Badge variant="outline">{matchedZones}</Badge>
                            </EventDetailRow>
                        )}
                        {ruleIds && (
                            <EventDetailRow label={t('components.eventCard.ruleId')}>
                                <span className="font-mono break-all">{ruleIds}</span>
                            </EventDetailRow>
                        )}
                        </>
                    )}
                </dl>

                {/* Message/Description */}
                {appSecEvent && message && (
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
                                {httpStatus && `${t('components.eventCard.status')}: ${httpStatus}`}
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
                                {t('components.eventCard.additionalMetadata', { count: additionalMeta.length })}
                            </span>
                        }
                        defaultOpen={false}
                    >
                        <div className="mt-1">
                            <MetadataTable entries={additionalMeta} />
                        </div>
                    </Collapsible>
                )}
            </div>
            </div>
        </div>
    );
}
