import { serve } from '@hono/node-server';
import { createApp } from './app';
import { attachCacheUpdateWebSocket } from './cache-update-websocket';
import { installTimestampedConsole } from './logging';

installTimestampedConsole();

const controller = createApp({ startBackgroundTasks: true });
const server = serve({
  fetch: controller.fetch,
  port: controller.config.port,
});
const cacheUpdateWebSocket = attachCacheUpdateWebSocket(server, controller);

console.log(`CrowdSec Web UI backend running at http://localhost:${controller.config.port}${controller.config.basePath || ''}/`);
if (controller.config.basePath) {
  console.log(`BASE_PATH configured: ${controller.config.basePath}`);
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
