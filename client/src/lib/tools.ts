import { Activity, Boxes, MapPinned, ScrollText, Bot, FileText, Globe2, History, Network, ListX, Repeat, Server, type LucideIcon } from 'lucide-react';

export interface ToolEntry {
  slug: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
}

export const TOOLS: readonly ToolEntry[] = [
  { slug: 'geo-blocking', icon: Globe2, titleKey: 'tools.geo.title', descriptionKey: 'tools.geo.summary' },
  { slug: 'attack-map', icon: MapPinned, titleKey: 'tools.attackMap.title', descriptionKey: 'tools.attackMap.summary' },
  { slug: 'asn', icon: Network, titleKey: 'tools.asn.title', descriptionKey: 'tools.asn.summary' },
  { slug: 'ip-timeline', icon: History, titleKey: 'tools.timeline.title', descriptionKey: 'tools.timeline.summary' },
  { slug: 'auto-ban', icon: Bot, titleKey: 'tools.autoBan.title', descriptionKey: 'tools.autoBan.summary' },
  { slug: 'repeat-offenders', icon: Repeat, titleKey: 'tools.offenders.title', descriptionKey: 'tools.offenders.summary' },
  { slug: 'blocklists', icon: ListX, titleKey: 'tools.blocklists.title', descriptionKey: 'tools.blocklists.summary' },
  { slug: 'hosts', icon: Server, titleKey: 'tools.hosts.title', descriptionKey: 'tools.hosts.summary' },
  { slug: 'wallboard', icon: Activity, titleKey: 'tools.wallboard.title', descriptionKey: 'tools.wallboard.summary' },
  { slug: 'hub', icon: Boxes, titleKey: 'tools.hub.title', descriptionKey: 'tools.hub.summary' },
  { slug: 'audit-log', icon: ScrollText, titleKey: 'tools.audit.title', descriptionKey: 'tools.audit.summary' },
  { slug: 'report', icon: FileText, titleKey: 'tools.report.title', descriptionKey: 'tools.report.summary' },
];
