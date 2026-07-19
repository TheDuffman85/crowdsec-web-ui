import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const baseUrl = process.env.CROWDSEC_SCREENSHOT_BASE_URL || "http://127.0.0.1:5173";
const screenshotDir = process.env.CROWDSEC_SCREENSHOT_OUTPUT_DIR || scriptDir;
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const userDataDir = join(tmpdir(), `crowdsec-web-ui-screenshots-chrome-${Date.now()}`);
const remotePort = Number.parseInt(process.env.CROWDSEC_SCREENSHOT_CHROME_PORT || "9224", 10);
const demoUsername = process.env.CROWDSEC_SCREENSHOT_USERNAME || "admin";
const demoPassword = process.env.CROWDSEC_SCREENSHOT_PASSWORD || "Screenshot123";

mkdirSync(screenshotDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http
      .request(url, { method }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
    req.end();
  });
}

function waitForProcessExit(processRef, timeoutMs = 3_000) {
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveWait) => {
    const timeout = setTimeout(resolveWait, timeoutMs);
    processRef.once("exit", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function waitForChrome() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await requestJson(`http://127.0.0.1:${remotePort}/json/version`);
    } catch {
      await sleep(150);
    }
  }
  throw new Error("Chrome did not expose DevTools in time");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: resolvePending, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolvePending(msg.result ?? {});
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) ?? [];
        for (const handler of handlers) handler(msg.params ?? {});
      }
    });
  }

  ready() {
    return new Promise((resolveReady, reject) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    });
  }

  on(method, handler) {
    const handlers = this.events.get(method) ?? [];
    handlers.push(handler);
    this.events.set(method, handlers);
  }

  close() {
    this.ws.close();
  }
}

async function createPage() {
  const tab = await requestJson(
    `http://127.0.0.1:${remotePort}/json/new?${encodeURIComponent(baseUrl)}`,
    "PUT",
  );
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1843,
    height: 1136,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  return cdp;
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.exception?.value ||
      result.exceptionDetails.text ||
      "Evaluation failed",
    );
  }
  return result.result?.value;
}

async function navigate(cdp, path) {
  await navigateDocument(cdp, path);
  await waitForAppSettled(cdp);
}

async function navigateDocument(cdp, path) {
  let loaded = false;
  const onLoad = () => {
    loaded = true;
  };
  cdp.on("Page.loadEventFired", onLoad);
  await cdp.send("Page.navigate", { url: `${baseUrl}${path}` });
  const deadline = Date.now() + 12_000;
  while (!loaded && Date.now() < deadline) await sleep(100);
  await waitForDocumentReady(cdp);
}

async function waitForDocumentReady(cdp) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      cdp,
      `document.readyState === "interactive" || document.readyState === "complete"`,
    );
    if (ready) return;
    await sleep(100);
  }
}

async function waitForAppSettled(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const settled = await evaluate(
      cdp,
      `(() => {
        const text = document.body.innerText || "";
        const loading = text.includes("Loading alerts...") ||
          text.includes("Loading decisions...") ||
          text.includes("Loading dashboard...") ||
          text.includes("Loading notifications...") ||
          text.includes("Loading...");
        const hasMain = !!document.querySelector("main");
        return hasMain && !loading;
      })()`,
    );
    if (settled) {
      await sleep(700);
      return;
    }
    await sleep(250);
  }
  await sleep(1_000);
}

async function prepareSession(cdp) {
  await navigateDocument(cdp, "/login");
  await evaluate(
    cdp,
    `(() => {
      localStorage.setItem("theme", "light");
      localStorage.setItem("menuOpen", "true");
      localStorage.setItem("dashboard_granularity", "hour");
      document.documentElement.classList.remove("dark");
      return true;
    })()`,
  );
  await evaluate(
    cdp,
    `(async () => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: ${JSON.stringify(demoUsername)},
          password: ${JSON.stringify(demoPassword)}
        })
      });
      if (!response.ok) {
        throw new Error("Demo login failed: " + response.status + " " + await response.text());
      }
      return true;
    })()`,
  );
}

async function clickByText(cdp, text) {
  await evaluate(
    cdp,
    `(() => {
      const targetText = ${JSON.stringify(text)};
      const elements = [...document.querySelectorAll("button, a, summary")];
      const el = elements.find((node) => (node.innerText || node.textContent || "").trim().includes(targetText));
      if (!el) throw new Error("Could not find clickable text: " + targetText);
      el.click();
      return true;
    })()`,
  );
  await sleep(500);
  await waitForAppSettled(cdp);
}

async function clickFirst(cdp, selector) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Could not find selector: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`,
  );
  await sleep(500);
  await waitForAppSettled(cdp);
}

async function closeModal(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const dialog = document.querySelector("[role='dialog']");
      const backdrop = dialog?.parentElement;
      if (!backdrop) throw new Error("Could not find open modal");
      backdrop.click();
      return true;
    })()`,
  );
  await sleep(500);
  await waitForAppSettled(cdp);
}

async function screenshot(cdp, name) {
  await evaluate(
    cdp,
    `(() => {
      document.documentElement.classList.remove("dark");
      document.body.style.background = "#f8fafc";
      window.scrollTo(0, 0);
      return true;
    })()`,
  );
  await sleep(350);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(join(screenshotDir, name), Buffer.from(data, "base64"));
  console.log(`Captured ${name}`);
}

async function main() {
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${remotePort}`,
    `${baseUrl}/`,
  ], { cwd: repoRoot, stdio: "ignore" });

  try {
    await waitForChrome();
    const cdp = await createPage();
    try {
      await prepareSession(cdp);

      await navigate(cdp, "/?instance=primary");
      await clickByText(cdp, "Hour");
      await screenshot(cdp, "dashboard.png");

      await screenshot(cdp, "update_available.png");

      await navigate(cdp, "/alerts?instance=all");
      await screenshot(cdp, "multi_instance.png");

      await navigate(cdp, "/alerts?instance=primary");
      await screenshot(cdp, "alerts.png");

      await clickFirst(cdp, "tbody tr");
      await screenshot(cdp, "alert_details.png");

      await closeModal(cdp);
      await clickFirst(cdp, "button[aria-label='Search syntax help']");
      await screenshot(cdp, "search_syntax.png");

      await navigate(cdp, "/decisions?instance=primary");
      await screenshot(cdp, "decisions.png");

      await clickByText(cdp, "Add Decision");
      await screenshot(cdp, "add_decision.png");

      await navigate(cdp, "/metrics?instance=primary");
      await screenshot(cdp, "metrics.png");

      await navigate(cdp, "/notifications");
      await screenshot(cdp, "notifications.png");

      await clickByText(cdp, "Add Rule");
      await screenshot(cdp, "notification_rule.png");

      await navigate(cdp, "/settings");
      await screenshot(cdp, "settings.png");
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
