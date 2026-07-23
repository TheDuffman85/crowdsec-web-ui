import { describe, expect, test } from 'vitest';
import type { FacetResponse } from '../../../shared/contracts';
import { QueryWorkerTimeoutError, type DatabaseQueryWorker } from '../../query-worker-client';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  seedAlert,
} from './harness';

describe('createApp facet API', () => {
  test('returns bounded alert facets and removes only the requested field from search', async () => {
    const alerts = [
      sampleAlert({
        id: 1,
        uuid: 'facet-alert-1',
        scenario: 'ssh',
        target: 'ssh',
        source: { ip: '1.1.1.1', cn: 'DE', as_name: 'Hetzner' },
      }),
      sampleAlert({
        id: 2,
        uuid: 'facet-alert-2',
        scenario: 'ssh',
        target: 'http',
        source: { ip: '2.2.2.2', cn: 'US', as_name: 'AWS' },
      }),
      sampleAlert({
        id: 3,
        uuid: 'facet-alert-3',
        scenario: 'nginx',
        target: 'nginx',
        source: { ip: '3.3.3.3', cn: 'DE', as_name: 'Hetzner' },
      }),
    ];
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    alerts.forEach((alert) => seedAlert(database, alert));

    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=country&q=scenario:ssh%20AND%20country:DE&limit=1',
    ));
    expect(response.status).toBe(200);
    expect(await response.json() as FacetResponse).toEqual({
      field: 'country',
      values: [{ value: 'DE', count: 1 }],
      offset: 0,
      has_more: true,
    });

    const nextResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=country&q=scenario:ssh%20AND%20country:DE&limit=1&offset=1',
    ));
    expect(await nextResponse.json() as FacetResponse).toEqual({
      field: 'country',
      values: [{ value: 'US', count: 1 }],
      offset: 1,
      has_more: false,
    });

    const targetResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=target&q=scenario:ssh%20AND%20target:ssh',
    ));
    expect(await targetResponse.json() as FacetResponse).toEqual({
      field: 'target',
      values: [
        { value: 'ssh', count: 1 },
        { value: 'http', count: 1 },
      ],
      offset: 0,
      has_more: false,
    });

    const deleteResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/1',
      { method: 'DELETE' },
    ));
    expect(deleteResponse.status).toBe(200);

    const invalidatedResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=country&q=scenario:ssh%20AND%20country:DE&limit=1',
    ));
    expect(await invalidatedResponse.json() as FacetResponse).toEqual({
      field: 'country',
      values: [{ value: 'US', count: 1 }],
      offset: 0,
      has_more: false,
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('supports value search, empty buckets, and clamps facet limits', async () => {
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'facet-empty',
      scenario: '',
      source: { ip: '1.1.1.1', cn: 'DE', as_name: '' },
    }));
    seedAlert(database, sampleAlert({
      id: 2,
      uuid: 'facet-named',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '2.2.2.2', cn: 'US', as_name: 'Amazon Web Services' },
    }));

    const emptyResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=scenario',
    ));
    expect((await emptyResponse.json() as FacetResponse).values).toContainEqual({ value: '', count: 1 });

    const searchResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=as&search=amazon&limit=999',
    ));
    const searchPayload = await searchResponse.json() as FacetResponse;
    expect(searchPayload.values).toEqual([{ value: 'Amazon Web Services', count: 1 }]);
    expect(searchPayload.values.length).toBeLessThanOrEqual(50);

    const cityResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=city',
    ));
    expect(cityResponse.status).toBe(200);

    const targetResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=target',
    ));
    expect(targetResponse.status).toBe(200);

    const invalidResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=unsupported',
    ));
    expect(invalidResponse.status).toBe(400);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('returns decision action and active/expired status counts', async () => {
    const now = Date.now();
    const { controller, database } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    seedAlert(database, sampleAlert({
      id: 1,
      uuid: 'facet-decisions',
      decisions: [
        {
          id: 10,
          value: '1.1.1.1',
          type: 'ban',
          stop_at: new Date(now + 60_000).toISOString(),
          origin: 'manual',
        },
        {
          id: 11,
          value: '2.2.2.2',
          type: 'captcha',
          stop_at: new Date(now - 60_000).toISOString(),
          origin: 'manual',
        },
      ],
    }));

    const statusResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=status',
    ));
    expect(statusResponse.status).toBe(200);
    expect((await statusResponse.json() as FacetResponse).values).toEqual(expect.arrayContaining([
      { value: 'active', count: 1 },
      { value: 'expired', count: 1 },
    ]));

    const actionResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=action&include_expired=true',
    ));
    expect((await actionResponse.json() as FacetResponse).values).toEqual(expect.arrayContaining([
      { value: 'ban', count: 1 },
      { value: 'captcha', count: 1 },
    ]));

    const targetResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=target&include_expired=true',
    ));
    expect((await targetResponse.json() as FacetResponse).values).toEqual([
      { value: 'ssh', count: 2 },
    ]);

    const alertDecisionResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=decision',
    ));
    expect((await alertDecisionResponse.json() as FacetResponse).values).toEqual(expect.arrayContaining([
      { value: 'active', count: 1 },
      { value: 'expired', count: 1 },
    ]));

    const linkedAlertResponse = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions/facets?field=alert&include_expired=true',
    ));
    expect((await linkedAlertResponse.json() as FacetResponse).values).toEqual([
      { value: '1', count: 2 },
    ]);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('maps isolated facet worker timeouts to 504', async () => {
    const facetQueryWorker = {
      all: async () => {
        throw new QueryWorkerTimeoutError(5_000);
      },
      close: () => undefined,
    } as unknown as DatabaseQueryWorker;
    const { controller, database } = createController({
      facetQueryWorker,
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });

    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/alerts/facets?field=country',
    ));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'Facet query timed out' });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
