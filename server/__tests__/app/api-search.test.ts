import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type {
  AlertRecord,
  DashboardStatsResponse,
  DecisionListItem,
  PaginatedResponse,
  SlimAlert,
} from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import {
  createController,
  dashboardDateKey,
  destroyTempDir,
  sampleAlert,
  sampleSimulatedAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp search API', () => {
  test('matches free-text alert searches against alert context values', async () => {
    const matchingAlert = sampleAlert({
      id: 1,
      uuid: 'alert-1',
      meta: [{ key: 'host', value: 'protected.example.test' }],
    });
    const otherAlert = sampleAlert({
      id: 2,
      uuid: 'alert-2',
      source: { ip: '5.6.7.8' },
      meta: [{ key: 'host', value: 'other.example.test' }],
    });
    const { controller, database } = createController({
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([matchingAlert, otherAlert])
        : undefined,
    });
    seedAlert(database, matchingAlert);
    seedAlert(database, otherAlert);

    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=protected.example.test',
    ));

    expect(response.status).toBe(200);
    expect((await response.json()) as PaginatedResponse<SlimAlert>).toEqual(expect.objectContaining({
      data: [expect.objectContaining({ id: 1, meta_search: expect.stringContaining('protected.example.test') })],
      pagination: expect.objectContaining({ total: 1 }),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('matches alert kinds in fielded and free-text searches', async () => {
    const wafAlert = sampleAlert({ id: 1, uuid: 'kind-waf', kind: 'waf', message: '' });
    const crowdsecAlert = sampleAlert({
      id: 2,
      uuid: 'kind-crowdsec',
      kind: 'crowdsec',
      message: '',
      source: { ip: '5.6.7.8', value: '5.6.7.8' },
      decisions: (sampleAlert().decisions || []).map((decision) => ({
        ...decision,
        id: 20,
        value: '5.6.7.8',
      })),
    });
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    seedAlert(database, wafAlert);
    seedAlert(database, crowdsecAlert);

    for (const query of ['kind=waf', 'waf']) {
      const response = await controller.fetch(new Request(
        `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${encodeURIComponent(query)}`,
      ));
      expect(response.status).toBe(200);
      expect((await response.json()) as PaginatedResponse<SlimAlert>).toEqual(expect.objectContaining({
        data: [expect.objectContaining({ id: 1, kind: 'waf' })],
        pagination: expect.objectContaining({ total: 1 }),
      }));
    }

    const decisionsResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=1&page_size=10&hide_duplicates=false&q=kind%3Dwaf',
    ));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as PaginatedResponse<DecisionListItem>).toEqual(expect.objectContaining({
      data: [expect.objectContaining({ id: 10, kind: 'waf' })],
      pagination: expect.objectContaining({ total: 1 }),
    }));

    const decisionFacetResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=kind&hide_duplicates=false',
    ));
    expect(decisionFacetResponse.status).toBe(200);
    expect(await decisionFacetResponse.json()).toEqual(expect.objectContaining({
      field: 'kind',
      values: [
        { value: 'crowdsec', count: 1 },
        { value: 'waf', count: 1 },
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('matches alert search queries against decision origins', async () => {
    const searchAlerts = [
      sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [
        { id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false },
        { id: 11, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'CAPI', simulated: false },
      ],
      }),
      sampleAlert({
      id: 2,
      uuid: 'alert-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: false }],
      }),
    ];
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=capi'));
    expect(response.status).toBe(200);
    expect((await response.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('filters alerts whose origin field is empty', async () => {
    const alertWithOrigin = sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [{
        id: 10,
        value: '1.2.3.4',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        simulated: false,
      }],
    });
    const alertWithoutOrigin = sampleAlert({
      id: 2,
      uuid: 'alert-2',
      source: { ip: '5.6.7.8', value: '5.6.7.8' },
      decisions: [],
    });
    const { controller, database } = createController({
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([alertWithOrigin, alertWithoutOrigin])
        : undefined,
    });
    seedAlert(database, alertWithOrigin);
    seedAlert(database, alertWithoutOrigin);

    const emptyUrl = new URL('http://localhost/crowdsec/api/alerts?page=1&page_size=10');
    emptyUrl.searchParams.set('q', 'origin:""');
    const emptyResponse = await controller.fetch(new Request(emptyUrl));
    expect(emptyResponse.status).toBe(200);
    expect((await emptyResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 2 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const nonEmptyUrl = new URL('http://localhost/crowdsec/api/alerts?page=1&page_size=10');
    nonEmptyUrl.searchParams.set('q', 'origin<>""');
    const nonEmptyResponse = await controller.fetch(new Request(nonEmptyUrl));
    expect(nonEmptyResponse.status).toBe(200);
    expect((await nonEmptyResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('matches decision search queries against machine and origin', async () => {
    const searchAlerts = [
      sampleAlert({
        id: 1,
        uuid: 'alert-1',
        machine_id: 'machine-1',
        machine_alias: 'host-a',
        decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
      }),
      sampleAlert({
        id: 2,
        uuid: 'alert-2',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: false }],
      }),
    ];
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const machineResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=host-a'));
    expect(machineResponse.status).toBe(200);
    expect((await machineResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const originResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=manual'));
    expect(originResponse.status).toBe(200);
    expect((await originResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('keeps the longest active decision visible when duplicate values are hidden', async () => {
    const createdAt = new Date().toISOString();
    const shortStopAt = new Date(Date.now() + 14 * 60 * 60 * 1_000).toISOString();
    const longStopAt = new Date(Date.now() + 62 * 60 * 60 * 1_000).toISOString();
    const duplicateAlert = sampleAlert({
      id: 110,
      uuid: 'alert-110',
      created_at: createdAt,
      source: { ip: '85.121.208.95', value: '85.121.208.95', cn: 'RO', as_name: 'Stylish By A&I Srl' },
      decisions: [
        {
          id: 10,
          type: 'ban',
          value: '85.121.208.95',
          duration: '14h',
          stop_at: shortStopAt,
          origin: 'crowdsec',
          scenario: 'crowdsecurity/appsec-native',
          simulated: false,
        },
        {
          id: 49,
          type: 'ban',
          value: '85.121.208.95',
          duration: '62h',
          stop_at: longStopAt,
          origin: 'crowdsec',
          scenario: 'crowdsecurity/http-probing',
          simulated: false,
        },
      ],
    });
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([duplicateAlert]);
        }
        return undefined;
      },
    });
    seedAlert(database, duplicateAlert);

    const defaultResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10'));
    expect(defaultResponse.status).toBe(200);
    expect((await defaultResponse.json()) as { data: Array<{ id: number; detail: { reason: string } }> }).toEqual(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            id: 49,
            detail: expect.objectContaining({ reason: 'crowdsecurity/http-probing' }),
          }),
        ],
      }),
    );

    const filteredResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=scenario%3Dcrowdsecurity%2Fappsec-native',
    ));
    expect(filteredResponse.status).toBe(200);
    expect((await filteredResponse.json()) as {
      data: Array<{ id: number; is_duplicate: boolean; detail: { reason: string } }>;
      pagination: { total: number };
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          id: 10,
          is_duplicate: false,
          detail: expect.objectContaining({ reason: 'crowdsecurity/appsec-native' }),
        }),
      ],
      pagination: expect.objectContaining({ total: 1 }),
    }));

    const filteredFacetResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=action&q=scenario%3Dcrowdsecurity%2Fappsec-native',
    ));
    expect(filteredFacetResponse.status).toBe(200);
    expect((await filteredFacetResponse.json()) as {
      values: Array<{ value: string; count: number }>;
    }).toEqual(expect.objectContaining({
      values: [expect.objectContaining({ value: 'ban', count: 1 })],
    }));

    const duplicatesResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&hide_duplicates=false'));
    expect(duplicatesResponse.status).toBe(200);
    expect((await duplicatesResponse.json()) as { data: Array<{ id: number; is_duplicate: boolean }> }).toEqual(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: 10, is_duplicate: true }),
          expect.objectContaining({ id: 49, is_duplicate: false }),
        ]),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('promotes the matching duplicate across a combined predicate for every decision filter family', async () => {
    const value = '198.51.100.91';
    const createdAt = new Date().toISOString();
    const matchingAlert = sampleAlert({
      id: 910,
      uuid: 'combined-filter-match',
      created_at: createdAt,
      scenario: 'crowdsecurity/combined-match',
      machine_id: 'machine-combined',
      machine_alias: 'host-combined',
      source: {
        ip: value,
        value,
        cn: 'DE',
        region: 'State of Berlin',
        city: 'Berlin',
        as_name: 'Hetzner Online',
      },
      target: 'ssh',
      decisions: [{
        id: 9101,
        value,
        created_at: createdAt,
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'lists',
        scenario: 'crowdsecurity/combined-match',
        simulated: false,
      }],
    });
    const excludedPrimaryAlert = sampleAlert({
      id: 911,
      uuid: 'combined-filter-primary',
      created_at: createdAt,
      scenario: 'crowdsecurity/excluded-primary',
      machine_alias: 'other-host',
      source: {
        ip: value,
        value,
        cn: 'US',
        region: 'Virginia',
        city: 'Ashburn',
        as_name: 'Other Network',
      },
      target: 'http',
      decisions: [{
        id: 9111,
        value,
        created_at: createdAt,
        stop_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        type: 'ban',
        origin: 'crowdsec',
        scenario: 'crowdsecurity/excluded-primary',
        simulated: false,
      }],
    });
    const { controller, database } = createController({
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });
    seedAlert(database, matchingAlert);
    seedAlert(database, excludedPrimaryAlert);
    database.refreshDecisionDuplicateFlags(new Date().toISOString());

    const dateStart = new Date(Date.now() - 60_000).toISOString();
    const query = [
      `id:${9101}`,
      'instance:default',
      `alert:${matchingAlert.id}`,
      'scenario:crowdsecurity/combined-match',
      `ip:${value}`,
      'country:DE',
      'region:"State of Berlin"',
      'city:Berlin',
      'as:"Hetzner Online"',
      'target:ssh',
      `date>=${dateStart}`,
      'action:ban',
      'status:active',
      'sim:live',
      'machine:host-combined',
      'origin:lists',
    ].join(' AND ');
    const response = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=${encodeURIComponent(query)}`,
    ));
    expect(response.status).toBe(200);
    expect((await response.json()) as PaginatedResponse<DecisionListItem>).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          id: 9101,
          is_duplicate: false,
        }),
      ],
      pagination: expect.objectContaining({
        total: 1,
      }),
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('supports advanced boolean search for alerts and decisions', async () => {
    const searchAlerts = [
      sampleAlert({
        id: 1,
        uuid: 'alert-1',
        machine_id: 'machine-1',
        machine_alias: 'host-a',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        decisions: [
          { id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false },
          { id: 11, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'CAPI', simulated: false },
        ],
      }),
      sampleAlert({
        id: 2,
        uuid: 'alert-2',
        machine_id: 'machine-2',
        machine_alias: 'host-b',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        decisions: [{ id: 20, value: '5.6.7.8', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'crowdsec', simulated: true }],
        simulated: true,
      }),
    ];
    const { controller, database } = createController({
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json(searchAlerts);
        }
        return undefined;
      },
    });

    for (const alert of searchAlerts) {
      seedAlert(database, alert);
    }

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=origin:(manual%20OR%20CAPI)%20AND%20-country:us'));
    expect(alertsResponse.status).toBe(200);
    expect((await alertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const liveAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=sim<>simulated'));
    expect(liveAlertsResponse.status).toBe(200);
    expect((await liveAlertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const typoAlertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=sim<>simulatd'));
    expect(typoAlertsResponse.status).toBe(200);
    expect((await typoAlertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [],
        pagination: expect.objectContaining({ total: 0 }),
      }),
    );

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=status:active%20AND%20alert:1%20AND%20duplicate:false'));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 11 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('treats underscores literally in scenario searches', async () => {
    const matchingAlert = sampleAlert({
      id: 1,
      uuid: 'alert-1',
      scenario: 'crowdsecurity/netgear_rce',
      source: { ip: '1.2.3.4', value: '1.2.3.4' },
      decisions: [{
        id: 10,
        value: '1.2.3.4',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'crowdsec',
        scenario: 'crowdsecurity/netgear_rce',
        simulated: false,
      }],
    });
    const wildcardLookalike = sampleAlert({
      id: 2,
      uuid: 'alert-2',
      scenario: 'crowdsecurity/netgearXrce',
      source: { ip: '5.6.7.8', value: '5.6.7.8' },
      decisions: [{
        id: 20,
        value: '5.6.7.8',
        stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        type: 'ban',
        origin: 'crowdsec',
        scenario: 'crowdsecurity/netgearXrce',
        simulated: false,
      }],
    });
    const { controller, database } = createController({
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([matchingAlert, wildcardLookalike])
        : undefined,
    });
    seedAlert(database, matchingAlert);
    seedAlert(database, wildcardLookalike);

    const query = encodeURIComponent('scenario:crowdsecurity/netgear_rce');
    const alertsResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${query}`,
    ));
    expect(alertsResponse.status).toBe(200);
    expect((await alertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const decisionsResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=${query}`,
    ));
    expect(decisionsResponse.status).toBe(200);
    expect((await decisionsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const exactQuery = encodeURIComponent('scenario=crowdsecurity/netgear_rce');
    const exactAlertsResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${exactQuery}`,
    ));
    expect(exactAlertsResponse.status).toBe(200);
    expect((await exactAlertsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const exactDecisionsResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=${exactQuery}`,
    ));
    expect(exactDecisionsResponse.status).toBe(200);
    expect((await exactDecisionsResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 10 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const exactPrefixQuery = encodeURIComponent('scenario=crowdsecurity/netgear');
    const exactPrefixResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${exactPrefixQuery}`,
    ));
    expect(exactPrefixResponse.status).toBe(200);
    expect((await exactPrefixResponse.json()) as { data: unknown[]; pagination: { total: number } }).toEqual(
      expect.objectContaining({ data: [], pagination: expect.objectContaining({ total: 0 }) }),
    );

    const notExactQuery = encodeURIComponent('scenario<>crowdsecurity/netgear_rce');
    const notExactResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${notExactQuery}`,
    ));
    expect(notExactResponse.status).toBe(200);
    expect((await notExactResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 2 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    const substringQuery = encodeURIComponent('gear_r');
    const substringResponse = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/alerts?page=1&page_size=10&q=${substringQuery}`,
    ));
    expect(substringResponse.status).toBe(200);
    expect((await substringResponse.json()) as { data: Array<{ id: number }>; pagination: { total: number } }).toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 1 })],
        pagination: expect.objectContaining({ total: 1 }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('serves the first paginated alert page from a 100k-row cache', async () => {
    const { controller, database } = createController({
      env: {
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });
    const now = Date.now();
    const seedLargeCache = database.db.transaction(() => {
      database.db.prepare(`
        WITH RECURSIVE row_numbers(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM row_numbers WHERE value < 100000
        )
        INSERT INTO alerts (
          id, uuid, created_at, scenario, source_ip, message, raw_data,
          country, country_name, region, city, as_name, target, machine, meta_search, origins, simulated, search_text
        )
        SELECT
          value,
          'perf-alert-' || value,
          ?,
          'perf/scenario',
          '10.42.0.1',
          'perf alert',
          NULL,
          'DE',
          'Germany',
          'State of Berlin',
          'Berlin',
          'Perf AS',
          'ssh',
          'perf-host',
          'perf',
          '',
          0,
          'perf scenario 10.42.0.1 germany ssh'
        FROM row_numbers
      `).run(new Date(now).toISOString());
      database.db.prepare(`
        INSERT INTO alerts_fts(rowid, alert_id, search_text)
        SELECT id, CAST(id AS TEXT), search_text FROM alerts
      `).run();
    });
    seedLargeCache();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=50&q=perf'));
    expect(response.status).toBe(200);
    const payload = await response.json() as PaginatedResponse<SlimAlert>;
    expect(payload.data).toHaveLength(50);
    expect(payload.pagination.total).toBe(100_000);
    expect(payload.selectable_ids).toHaveLength(50);

    const cityResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts?page=1&page_size=50&q=city:Berlin%20AND%20region:%22State%20of%20Berlin%22',
    ));
    expect(cityResponse.status).toBe(200);
    const cityPayload = await cityResponse.json() as PaginatedResponse<SlimAlert>;
    expect(cityPayload.data).toHaveLength(50);
    expect(cityPayload.pagination.total).toBe(100_000);
    expect(cityPayload.data[0]?.source).toMatchObject({ city: 'Berlin', region: 'State of Berlin' });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  }, 15_000);

  test('returns a 400 for invalid advanced search queries', async () => {
    const { controller, database } = createController();

    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'alert-1',
      decisions: [{ id: 10, value: '1.2.3.4', stop_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), type: 'ban', origin: 'manual', simulated: false }],
    }));

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10&q=origin:(manual%20OR'));
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; details: { position: number } }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Missing closing parenthesis'),
        details: expect.objectContaining({
          position: expect.any(Number),
        }),
      }),
    );

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('validates bad ids and malformed input', async () => {
    const { controller, database, lapiClient } = createController();
    await lapiClient.login();

    const badAlertId = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/not-a-number'));
    expect(badAlertId.status).toBe(400);

    const badDecisionId = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/not-a-number', { method: 'DELETE' }));
    expect(badDecisionId.status).toBe(400);

    const badBulkAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['oops'] }),
    }));
    expect(badBulkAlerts.status).toBe(400);

    const badBulkDecisions = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['oops'] }),
    }));
    expect(badBulkDecisions.status).toBe(400);

    const badCleanupIp = await controller.fetch(new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: 'bad-ip' }),
    }));
    expect(badCleanupIp.status).toBe(400);

    const badInterval = await controller.fetch(
      new Request('http://localhost/crowdsec/api/config/refresh-interval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: '9m' }),
      }),
    );
    expect(badInterval.status).toBe(400);

    const badDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: 'bad-ip' }),
      }),
    );
    expect(badDecision.status).toBe(400);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
 });
