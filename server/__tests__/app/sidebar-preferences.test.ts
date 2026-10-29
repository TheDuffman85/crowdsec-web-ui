import { afterEach, describe, expect, test } from 'vitest';
import { createController, destroyTempDir } from './harness';

const controllers: ReturnType<typeof createController>['controller'][] = [];

function start(options: Parameters<typeof createController>[0] = {}) {
  const result = createController(options);
  controllers.push(result.controller);
  return result;
}

function update(sidebar: string, visible: unknown) {
  return new Request(`http://localhost/crowdsec/api/config/${sidebar}-sidebar`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible }),
  });
}

async function readConfig(controller: ReturnType<typeof createController>['controller']) {
  return (await controller.fetch(new Request('http://localhost/crowdsec/api/config'))).json();
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.stopBackgroundTasks();
    controller.database.close();
  }
  destroyTempDir();
});

describe.each([
  ['allowlists', 'ui.allowlistsSidebarVisible', 'CONFIG_UI_ALLOWLISTS_SIDEBAR_VISIBLE', 403],
  ['metrics', 'ui.metricsSidebarVisible', 'CONFIG_UI_METRICS_SIDEBAR_VISIBLE', 200],
] as const)('%s sidebar visibility', (sidebar, configPath, envName, readOnlyStatus) => {
  const key = `${sidebar}_sidebar_visible`;

  test('defaults on, persists changes across restart, and keeps the page route available', async () => {
    const { controller, database } = start();
    expect(await readConfig(controller)).toMatchObject({ [key]: true });
    expect((await readConfig(controller)).managed_settings).not.toHaveProperty(key);

    const response = await controller.fetch(update(sidebar, false));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, [key]: false });
    expect(database.getMeta(key)?.value).toBe('false');
    expect(await readConfig(controller)).toMatchObject({ [key]: false });
    expect((await controller.fetch(new Request(`http://localhost/crowdsec/${sidebar}`))).status).toBe(200);

    controller.stopBackgroundTasks();
    database.close();
    controllers.pop();
    const restarted = start().controller;
    expect(await readConfig(restarted)).toMatchObject({ [key]: false });
    expect((await restarted.fetch(update(sidebar, true))).status).toBe(200);
    expect(await readConfig(restarted)).toMatchObject({ [key]: true });
  });

  test.each(['false', 'true'])('configuration overrides the saved preference with %s and locks updates', async (visible) => {
    const { controller, database } = start();
    await controller.fetch(update(sidebar, visible !== 'true'));
    controller.stopBackgroundTasks();
    database.close();
    controllers.pop();
    const managed = start({ env: { [envName]: visible } }).controller;
    expect(await readConfig(managed)).toMatchObject({
      [key]: visible === 'true',
      managed_settings: {
        [key]: { path: configPath, env: envName },
      },
    });
    const response = await managed.fetch(update(sidebar, visible !== 'true'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MANAGED_BY_CONFIG' });
  });

  test('rejects invalid visibility and respects existing read-only permissions', async () => {
    const { controller } = start();
    expect((await controller.fetch(update(sidebar, 'false'))).status).toBe(400);
    expect(await readConfig(controller)).toMatchObject({ [key]: true });
    const readOnly = start({ env: { CONFIG_UI_READ_ONLY: 'true' } }).controller;
    expect((await readOnly.fetch(update(sidebar, false))).status).toBe(readOnlyStatus);
    expect(await readConfig(readOnly)).toMatchObject({ [key]: readOnlyStatus !== 200 });
  });
});
