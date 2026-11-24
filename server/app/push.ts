import type { Hono } from 'hono';
import type { DashboardAuth } from '../app-auth';
import type { AuditLogger } from '../audit-log';
import { isValidSubscription } from '../notifications/web-push';
import type { WebPushService } from '../notifications/web-push-service';

/** Lets a signed-in administrator turn Web Push on or off for the browser they are using. */
export function registerPushRoutes(options: {
  app: Hono;
  basePath: string;
  auth: DashboardAuth;
  push: WebPushService;
  audit: AuditLogger;
}): void {
  const { app, basePath, auth, push, audit } = options;
  const forbidden = (context: any) => context.json({ error: 'Administrator access required', code: 'FORBIDDEN' }, 403);
  const allowed = (context: any) => auth.getPermissions(context).can_manage_settings;

  app.get(`${basePath}/api/push/status`, auth.ensureAuth, (context) => {
    if (!allowed(context)) return forbidden(context);
    const endpoint = context.req.query('endpoint');
    return context.json({
      public_key: push.publicKey(),
      subscriptions: push.subscriptionCount(),
      subscribed: endpoint ? push.hasSubscription(endpoint) : false,
    });
  });

  app.post(`${basePath}/api/push/subscribe`, auth.ensureAuth, async (context) => {
    if (!allowed(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const subscription = { endpoint: body?.endpoint, p256dh: body?.keys?.p256dh, auth: body?.keys?.auth };
    if (!isValidSubscription(subscription)) return context.json({ error: 'Invalid push subscription' }, 400);
    try {
      await push.addSubscription(subscription, { username: auth.getSession(context)?.username ?? 'unknown', userAgent: context.req.header('user-agent') });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Failed to save the subscription' }, 400);
    }
    audit.record(context, { action: 'push.subscribe', outcome: 'success', push_service: new URL(subscription.endpoint).hostname });
    return context.json({ success: true, subscriptions: push.subscriptionCount() }, 201);
  });

  app.post(`${basePath}/api/push/unsubscribe`, auth.ensureAuth, async (context) => {
    if (!allowed(context)) return forbidden(context);
    const body = await context.req.json().catch(() => null) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== 'string' || !body.endpoint) return context.json({ error: 'An endpoint is required' }, 400);
    const removed = await push.removeSubscription(body.endpoint);
    if (removed) audit.record(context, { action: 'push.unsubscribe', outcome: 'success', push_service: (() => { try { return new URL(body.endpoint as string).hostname; } catch { return 'unknown'; } })() });
    return context.json({ success: true, removed, subscriptions: push.subscriptionCount() });
  });
}
