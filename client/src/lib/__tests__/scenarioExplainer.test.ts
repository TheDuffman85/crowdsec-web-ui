import { describe, expect, test } from 'vitest';
import en from '../../locales/en.json';
import { explainScenario, type ScenarioCategory } from '../scenarioExplainer';

describe('explainScenario', () => {
  test.each<[string, ScenarioCategory, 'low' | 'medium' | 'high']>([
    ['crowdsecurity/ssh-bf', 'sshBruteForce', 'medium'],
    ['crowdsecurity/ssh-slow-bf', 'sshBruteForce', 'medium'],
    ['crowdsecurity/ssh-bf_user-enum', 'userEnumeration', 'low'],
    ['crowdsecurity/ssh-cve-2024-6387', 'exploitAttempt', 'high'],
    ['crowdsecurity/http-probing', 'webProbing', 'low'],
    ['crowdsecurity/http-sensitive-files', 'webProbing', 'low'],
    ['crowdsecurity/http-bad-user-agent', 'badBot', 'low'],
    ['crowdsecurity/http-crawl-non_statics', 'badBot', 'low'],
    ['crowdsecurity/http-sqli-probing', 'injection', 'high'],
    ['crowdsecurity/http-path-traversal-probing', 'injection', 'high'],
    ['crowdsecurity/http-backdoors-attempts', 'exploitAttempt', 'high'],
    ['crowdsecurity/CVE-2022-26134', 'exploitAttempt', 'high'],
    ['crowdsecurity/vpatch-CVE-2023-22527', 'exploitAttempt', 'high'],
    ['crowdsecurity/http-wordpress_bf', 'loginBruteForce', 'medium'],
    ['crowdsecurity/mysql-bf', 'loginBruteForce', 'medium'],
    ['crowdsecurity/iptables-scan-multi_ports', 'portScan', 'low'],
    ['crowdsecurity/nginx-req-limit-exceeded', 'rateLimit', 'low'],
    ['crowdsecurity/postfix-spam', 'spam', 'medium'],
    ['crowdsecurity/http-open-proxy', 'openProxy', 'low'],
  ])('%s is %s (%s)', (scenario, category, severity) => {
    expect(explainScenario(scenario)).toEqual({ category, severity });
  });

  test('works without an author prefix and ignores case', () => {
    expect(explainScenario('SSH-BF')?.category).toBe('sshBruteForce');
  });

  test('returns null for empty or unrecognised scenarios', () => {
    expect(explainScenario(undefined)).toBeNull();
    expect(explainScenario('')).toBeNull();
    expect(explainScenario('crowdsecurity/')).toBeNull();
    expect(explainScenario('acme/totally-custom-thing')).toBeNull();
    expect(explainScenario('manual/web-ui')).toBeNull();
  });

  test('every category and severity has English text', () => {
    const messages = en as Record<string, string>;
    const categories: ScenarioCategory[] = ['sshBruteForce', 'loginBruteForce', 'userEnumeration', 'webProbing', 'badBot', 'injection', 'exploitAttempt', 'portScan', 'rateLimit', 'spam', 'openProxy'];
    for (const category of categories) expect(messages[`components.scenarioExplainer.category.${category}`]).toBeTruthy();
    for (const severity of ['low', 'medium', 'high']) expect(messages[`components.scenarioExplainer.severity.${severity}`]).toBeTruthy();
  });
});
