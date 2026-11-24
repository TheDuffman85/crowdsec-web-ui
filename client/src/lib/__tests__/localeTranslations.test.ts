import { describe, expect, test } from 'vitest';
import ar from '../../locales/ar.json';
import de from '../../locales/de.json';
import en from '../../locales/en.json';
import es from '../../locales/es.json';
import fr from '../../locales/fr.json';
import hi from '../../locales/hi.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import pt from '../../locales/pt.json';
import ru from '../../locales/ru.json';
import zh from '../../locales/zh.json';

const locales: Record<string, Record<string, string>> = { ar, de, es, fr, hi, ja, ko, pt, ru, zh };
const english = en as Record<string, string>;

/**
 * Keys whose text is legitimately the same as English in one or more languages: product and protocol names
 * (CSV, SSO, TOTP, Symlog), language names, placeholders-only strings and words that are used unchanged
 * (Status, Local, Spam). Anything else that matches English was never translated and fails the test below.
 * Add a key here only after checking that the English wording really is correct for those languages.
 */
const SAME_AS_ENGLISH = new Set([
  'common.live',
  'common.name',
  'common.offline',
  'common.online',
  'components.banPresets.reasonSpam',
  'components.dashboardCharts.linear',
  'components.dashboardCharts.symlog',
  'components.eventCard.router',
  'components.eventCard.service',
  'components.eventCard.status',
  'components.exportCsv.button',
  'components.ipIntel.usage',
  'components.notes.byAuthor',
  'components.protectionCoverage.bouncers',
  'components.protectionCoverage.machines',
  'components.quickFilters.status',
  'components.savedFilters.name',
  'components.searchSyntax.aliases',
  'components.sessions.methodOidc',
  'components.sessions.methodPasskey',
  'components.sidebar.instance',
  'components.sidebar.nav.allowlists',
  'components.sidebar.nav.dashboard',
  'components.sidebar.nav.notifications',
  'components.threatScore.factor.reputation',
  'languages.ar',
  'languages.de',
  'languages.en',
  'languages.es',
  'languages.fr',
  'languages.hi',
  'languages.ja',
  'languages.ko',
  'languages.pt',
  'languages.ru',
  'languages.zh',
  'pages.alerts.coordinates',
  'pages.alerts.session',
  'pages.allowlists.columns.description',
  'pages.allowlists.columns.instances',
  'pages.allowlists.title',
  'pages.dashboard.as',
  'pages.dashboard.crowdsecLapi',
  'pages.dashboard.crowdsecLapis',
  'pages.dashboard.global',
  'pages.dashboard.ip',
  'pages.dashboard.mode',
  'pages.dashboard.simulation',
  'pages.dashboard.title',
  'pages.dashboard.topAs',
  'pages.decisions.allowlistedOn',
  'pages.decisions.typeCaptcha',
  'pages.metrics.columns.route',
  'pages.metrics.heartbeatOnline',
  'pages.metrics.instance',
  'pages.metrics.machines',
  'pages.metrics.version',
  'pages.notifications.appriseMode',
  'pages.notifications.appriseUrl',
  'pages.notifications.discordWebhookUrl',
  'pages.notifications.gotifyUrl',
  'pages.notifications.tags',
  'pages.notifications.url',
  'pages.settings.branding',
  'pages.settings.general',
  'pages.settings.logo',
  'pages.settings.neutralTones.neutral',
  'pages.settings.neutralTones.zinc',
  'pages.settings.oidcIssuerUrl',
  'pages.settings.oidcSso',
  'pages.settings.passkey',
  'pages.settings.passkeys',
  'pages.settings.themePreviewLink',
  'pages.settings.userPasskeyCount',
  'pages.settings.userRoleAdmin',
  'pages.settings.userSourceLinked',
  'pages.settings.userSourceLocal',
  'pages.settings.userSourceOidc',
  'pages.settings.userTotp',
  'pages.statistics.ipCount',
  'pages.statistics.machineCount',
  'pages.statistics.top',
  'server.notifications.ruleTest.title',
  'tableColumns.as',
  'tableColumns.id',
  'tableColumns.instance',
  'tableColumns.message',
  'tableColumns.region',
  'tableColumns.scenario',
  'tools.asn.filter',
  'tools.asn.ips',
  'tools.audit.actionLabel',
  'tools.autoBan.ruleName',
  'tools.autoBan.status',
  'tools.blocklists.kindCommunity',
  'tools.blocklists.kindLocal',
  'tools.blocklists.total',
  'tools.geo.status',
  'tools.hosts.title',
  'tools.hub.actionFor',
  'tools.hub.col.actions',
  'tools.hub.col.description',
  'tools.hub.col.name',
  'tools.hub.col.status',
  'tools.hub.type.collections',
  'tools.hub.type.parsers',
  'tools.hub.type.postoverflows',
  'tools.timeline.kind.note',
  'tools.timeline.machine',
]);

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');

describe('locale translations', () => {
  test.each(Object.keys(locales))('%s has no untranslated English text', (language) => {
    const untranslated = Object.keys(english).filter((key) => (
      locales[language]![key] === english[key] && !SAME_AS_ENGLISH.has(key)
    ));
    expect(untranslated).toEqual([]);
  });

  test.each(Object.keys(locales))('%s has every Tools page key', (language) => {
    const missing = Object.keys(english).filter((key) => key.startsWith('tools.') && !(key in locales[language]!));
    expect(missing).toEqual([]);
  });

  test.each(Object.keys(locales))('%s keeps the placeholders of the English text', (language) => {
    const mismatched = Object.keys(locales[language]!)
      .filter((key) => key in english && placeholders(locales[language]![key]!) !== placeholders(english[key]!));
    expect(mismatched).toEqual([]);
  });
});
