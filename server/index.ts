import { serve } from '@hono/node-server';
import { createApp } from './app';
import { installTimestampedConsole } from './logging';

installTimestampedConsole();

const controller = createApp({ startBackgroundTasks: true });
const server = serve({
  fetch: controller.fetch,
  port: controller.config.port,
});

console.log(`CrowdSec Web UI backend running at http://localhost:${controller.config.port}${controller.config.basePath || ''}/`);
if (controller.config.basePath) {
  console.log(`BASE_PATH configured: ${controller.config.basePath}`);
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down...`);
  controller.stopBackgroundTasks();
  server.close(() => {
    controller.database.close();
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { controller, server };
