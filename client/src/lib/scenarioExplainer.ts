export type ScenarioSeverity = 'low' | 'medium' | 'high';

export type ScenarioCategory =
  | 'sshBruteForce'
  | 'loginBruteForce'
  | 'userEnumeration'
  | 'webProbing'
  | 'badBot'
  | 'injection'
  | 'exploitAttempt'
  | 'portScan'
  | 'rateLimit'
  | 'spam'
  | 'openProxy';

export interface ScenarioExplanation {
  category: ScenarioCategory;
  severity: ScenarioSeverity;
}

const CATEGORY_SEVERITY: Record<ScenarioCategory, ScenarioSeverity> = {
  sshBruteForce: 'medium',
  loginBruteForce: 'medium',
  userEnumeration: 'low',
  webProbing: 'low',
  badBot: 'low',
  injection: 'high',
  exploitAttempt: 'high',
  portScan: 'low',
  rateLimit: 'low',
  spam: 'medium',
  openProxy: 'low',
};

// Checked in order, so the more specific patterns come first. They match the
// part of the scenario name after the author (`crowdsecurity/ssh-bf` -> `ssh-bf`).
const RULES: Array<{ pattern: RegExp; category: ScenarioCategory }> = [
  { pattern: /(user[-_]?enum|enum[-_]?user)/i, category: 'userEnumeration' },
  { pattern: /(sqli|xss|path[-_]?traversal|injection|lfi|rfi)/i, category: 'injection' },
  { pattern: /(cve[-_]?\d|rce|backdoor|vpatch|appsec|exploit|shellshock|log4j|w00tw00t)/i, category: 'exploitAttempt' },
  { pattern: /open[-_]?proxy/i, category: 'openProxy' },
  { pattern: /(bad[-_]?user[-_]?agent|crawl|scrapers?|bot)/i, category: 'badBot' },
  { pattern: /(req[-_]?limit|rate[-_]?limit|flood)/i, category: 'rateLimit' },
  { pattern: /(scan|probing|sensitive[-_]?files|admin[-_]?interface)/i, category: 'webProbing' },
  { pattern: /(spam|postfix|dovecot|exim)/i, category: 'spam' },
  { pattern: /^ssh/i, category: 'sshBruteForce' },
  { pattern: /(^|[-_])bf($|[-_])|brute/i, category: 'loginBruteForce' },
];

// Overrides where the name alone would land in the wrong bucket.
const EXACT: Record<string, ScenarioCategory> = {
  'iptables-scan-multi_ports': 'portScan',
  'ssh-bf': 'sshBruteForce',
  'ssh-slow-bf': 'sshBruteForce',
  'ssh-cve-2024-6387': 'exploitAttempt',
  'http-probing': 'webProbing',
  'http-crawl-non_statics': 'badBot',
};

function shortName(scenario: string): string {
  const slash = scenario.indexOf('/');
  return (slash === -1 ? scenario : scenario.slice(slash + 1)).trim();
}

/** Plain-English category and severity for a CrowdSec scenario, or null when it is not recognised. */
export function explainScenario(scenario: string | null | undefined): ScenarioExplanation | null {
  if (!scenario) return null;
  const name = shortName(scenario);
  if (!name) return null;

  let category: ScenarioCategory | undefined = EXACT[name.toLowerCase()];
  if (!category && /^(iptables|portscan|nmap)/i.test(name)) category = 'portScan';
  if (!category) category = RULES.find((rule) => rule.pattern.test(name))?.category;
  if (!category) return null;
  return { category, severity: CATEGORY_SEVERITY[category] };
}
