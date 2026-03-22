import { createApp } from './src/backend/app';

const originalLog = console.log;
const originalError = console.error;

console.log = (...args: unknown[]) => {
  originalLog(`[${new Date().toISOString()}]`, ...args);
};

console.error = (...args: unknown[]) => {
  originalError(`[${new Date().toISOString()}]`, ...args);
};

const controller = createApp({ startBackgroundTasks: true });

console.log(`CrowdSec Web UI backend running at http://localhost:${controller.config.port}${controller.config.basePath || ''}/`);
if (controller.config.basePath) {
  console.log(`BASE_PATH configured: ${controller.config.basePath}`);
}

export default {
  port: controller.config.port,
  fetch: controller.fetch,
};
