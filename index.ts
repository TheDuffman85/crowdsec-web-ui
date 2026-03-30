import { serve } from '@hono/node-server';
import { createApp } from './src/backend/app';

const originalLog = console.log.bind(console);
const originalInfo = console.info.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
const originalDebug = console.debug.bind(console);

function withTimestamp(writer: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    writer(`[${new Date().toISOString()}]`, ...args);
  };
}

console.log = withTimestamp(originalLog);
console.info = withTimestamp(originalInfo);
console.warn = withTimestamp(originalWarn);
console.error = withTimestamp(originalError);
console.debug = withTimestamp(originalDebug);

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
  server.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { controller, server };
