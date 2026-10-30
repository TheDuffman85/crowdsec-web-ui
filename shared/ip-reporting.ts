import type { IpReportCategoryRule, IpReporterConfig } from './contracts';

export const ABUSEIPDB_CATEGORIES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: 'DNS Compromise' },
  { id: 2, name: 'DNS Poisoning' },
  { id: 3, name: 'Fraud Orders' },
  { id: 4, name: 'DDoS Attack' },
  { id: 5, name: 'FTP Brute-Force' },
  { id: 6, name: 'Ping of Death' },
  { id: 7, name: 'Phishing' },
  { id: 8, name: 'Fraud VoIP' },
  { id: 9, name: 'Open Proxy' },
  { id: 10, name: 'Web Spam' },
  { id: 11, name: 'Email Spam' },
  { id: 12, name: 'Blog Spam' },
  { id: 13, name: 'VPN IP' },
  { id: 14, name: 'Port Scan' },
  { id: 15, name: 'Hacking' },
  { id: 16, name: 'SQL Injection' },
  { id: 17, name: 'Spoofing' },
  { id: 18, name: 'Brute-Force' },
  { id: 19, name: 'Bad Web Bot' },
  { id: 20, name: 'Exploited Host' },
  { id: 21, name: 'Web App Attack' },
  { id: 22, name: 'SSH' },
  { id: 23, name: 'IoT Targeted' },
];

export const IP_REPORT_COMMENT_VARIABLES = ['ip', 'scenarios', 'alerts', 'first_seen', 'last_seen', 'instances'] as const;

export const DEFAULT_IP_REPORT_COMMENT_TEMPLATE = 'CrowdSec detected {{scenarios}} ({{alerts}} alerts, last seen {{last_seen}})';

export const DEFAULT_IP_REPORT_CATEGORY_RULES: ReadonlyArray<IpReportCategoryRule> = [
  { pattern: '*ssh*', categories: [18, 22] },
  { pattern: '*ftp*', categories: [5, 18] },
  { pattern: '*sqli*', categories: [16, 21] },
  { pattern: '*scan*', categories: [14] },
  { pattern: '*crawl*', categories: [19] },
  { pattern: '*bad-user-agent*', categories: [19] },
  { pattern: '*spam*', categories: [11] },
  { pattern: '*dos*', categories: [4] },
  { pattern: '*-bf*', categories: [18] },
  { pattern: '*http*', categories: [21] },
  { pattern: '*appsec*', categories: [21] },
  { pattern: '*vpatch*', categories: [21] },
  { pattern: '*cve*', categories: [21] },
];

export function defaultIpReporterConfig(): IpReporterConfig {
  return {
    apiKey: '',
    submitMode: 'bulk',
    intervalMinutes: 360,
    cooldownHours: 24,
    maxReportsPerRun: 1000,
    minAlerts: 1,
    includeSimulated: false,
    instanceIds: [],
    includeScenarios: [],
    excludeScenarios: [],
    categoryRules: DEFAULT_IP_REPORT_CATEGORY_RULES.map((rule) => ({ ...rule, categories: [...rule.categories] })),
    defaultCategories: [15],
    commentTemplate: DEFAULT_IP_REPORT_COMMENT_TEMPLATE,
  };
}
