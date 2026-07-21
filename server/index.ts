import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachCacheUpdateWebSocket } from './cache-update-websocket';
import { installTimestampedConsole } from './logging';
import { formatStartupError } from './startup-error';

installTimestampedConsole();

let controller: ReturnType<typeof createApp>;
let server: ReturnType<typeof serve>;
let cacheUpdateWebSocket: ReturnType<typeof attachCacheUpdateWebSocket>;

try {
  controller = createApp({ startBackgroundTasks: true });
  server = serve({
    fetch: controller.fetch,
    port: controller.config.port,
  });
  cacheUpdateWebSocket = attachCacheUpdateWebSocket(server, controller);

  console.log(`CrowdSec Web UI backend running at http://localhost:${controller.config.port}${controller.config.basePath || ''}/`);
  if (controller.config.basePath) {
    console.log(`BASE_PATH configured: ${controller.config.basePath}`);
  }
} catch (error) {
  console.error(formatStartupError(error));
  process.exit(1);
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down...`);
  cacheUpdateWebSocket.close();
  controller.stopBackgroundTasks();
  server.close(() => {
    controller.database.close();
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { controller, server };
