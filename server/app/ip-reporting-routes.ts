import type { Hono } from 'hono';
import type { IpReportPreviewRequest, UpsertIpReporterRequest } from '../../shared/contracts';
import type { IpReportingService } from '../ip-reporting/service';

type HonoContext = any;
type HonoMiddleware = (context: HonoContext, next: () => Promise<void>) => Promise<Response | void>;

function errorStatus(error: unknown): 400 | 404 {
  return error instanceof Error && error.message === 'IP reporter not found' ? 404 : 400;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function registerIpReportingRoutes(options: {
  app: Hono;
  basePath: string;
  ensureAuth: HonoMiddleware;
  ensureCanManageSettings: (context: HonoContext) => Response | null;
  ipReportingService: IpReportingService;
}): void {
  const { app, basePath, ensureAuth, ensureCanManageSettings, ipReportingService } = options;
  const root = `${basePath}/api/ip-reporters`;

  app.get(root, ensureAuth, (context) => context.json({ reporters: ipReportingService.listReporters() }));

  app.post(root, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<UpsertIpReporterRequest>();
      return context.json(await ipReportingService.createReporter(body), 201);
    } catch (error) {
      return context.json({ error: errorMessage(error, 'Failed to create IP reporter') }, 400);
    }
  });

  app.post(`${root}/preview`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<IpReportPreviewRequest>();
      return context.json(await ipReportingService.preview(body));
    } catch (error) {
      return context.json({ error: errorMessage(error, 'Failed to preview IP reports') }, 400);
    }
  });

  app.put(`${root}/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      const body = await context.req.json<UpsertIpReporterRequest>();
      return context.json(await ipReportingService.updateReporter(String(context.req.param('id')), body));
    } catch (error) {
      return context.json({ error: errorMessage(error, 'Failed to update IP reporter') }, errorStatus(error));
    }
  });

  app.delete(`${root}/:id`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    await ipReportingService.deleteReporter(String(context.req.param('id')));
    return context.json({ success: true });
  });

  app.get(`${root}/:id/runs`, ensureAuth, (context) => {
    try {
      return context.json({ runs: ipReportingService.listRuns(String(context.req.param('id'))) });
    } catch (error) {
      return context.json({ error: errorMessage(error, 'Failed to load report runs') }, errorStatus(error));
    }
  });

  app.post(`${root}/:id/run`, ensureAuth, async (context) => {
    const readOnlyResponse = ensureCanManageSettings(context);
    if (readOnlyResponse) return readOnlyResponse;

    try {
      return context.json(await ipReportingService.runReporter(String(context.req.param('id')), 'manual'));
    } catch (error) {
      return context.json({ error: errorMessage(error, 'Failed to run IP report') }, errorStatus(error));
    }
  });
}
