import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { LapiClient } from '../server/lapi.ts';

const image = process.env.CROWDSEC_MTLS_IMAGE || 'crowdsecurity/crowdsec:latest';
const keepContainer = process.env.CROWDSEC_MTLS_KEEP === '1';
const containerName = process.env.CROWDSEC_MTLS_CONTAINER || `crowdsec-web-ui-mtls-${Date.now()}`;
const machineCommonName = 'crowdsec-web-ui-mtls';
const agentOu = 'agent-ou';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.\n${output}`);
  }

  return result.stdout.trim();
}

function runQuiet(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: 'ignore',
    ...options,
  });
}

function ensureCommand(command) {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Required command not found: ${command}`);
  }
}

function generateCertificates(workDir) {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: workDir, stdio: 'ignore' });

  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=CrowdSec Web UI mTLS Test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    'ca-key.pem',
    '-out',
    'ca.pem',
  );

  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-keyout',
    'server-key.pem',
    '-out',
    'server.csr',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca-key.pem',
    '-CAcreateserial',
    '-days',
    '1',
    '-copy_extensions',
    'copy',
    '-out',
    'server.pem',
  );

  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${machineCommonName}/OU=${agentOu}`,
    '-addext',
    'extendedKeyUsage=clientAuth',
    '-keyout',
    'agent-key.pem',
    '-out',
    'agent.csr',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    'agent.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca-key.pem',
    '-days',
    '1',
    '-copy_extensions',
    'copy',
    '-out',
    'agent.pem',
  );
}

function writeCrowdSecTlsOverride(workDir) {
  writeFileSync(
    path.join(workDir, 'config.yaml.local'),
    `api:
  server:
    listen_uri: 0.0.0.0:8080
    tls:
      cert_file: /mtls/server.pem
      key_file: /mtls/server-key.pem
      ca_cert_path: /mtls/ca.pem
      client_verification: RequireAndVerifyClientCert
      agents_allowed_ou:
        - ${agentOu}
`,
    'utf8',
  );
}

function dockerLogs(container) {
  const result = spawnSync('docker', ['logs', '--tail', '200', container], {
    encoding: 'utf8',
  });
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePublishedPort(output) {
  const match = output.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::):(\d+)$/m);
  if (!match) {
    throw new Error(`Could not parse CrowdSec published port from: ${output}`);
  }
  return match[1];
}

async function waitForLogin(createClient, container) {
  const deadline = Date.now() + 90_000;
  let lastError = 'CrowdSec did not become ready before the timeout.';

  while (Date.now() < deadline) {
    const client = createClient();
    const loggedIn = await Promise.race([
      client.login('CrowdSec mTLS smoke'),
      delay(5_000).then(() => false),
    ]);

    if (loggedIn) {
      return client;
    }

    lastError = client.getStatus().lastError || lastError;
    await delay(1_000);
  }

  throw new Error(`${lastError}\n\nCrowdSec logs:\n${dockerLogs(container)}`);
}

async function assertNoClientCertificateIsRejected(baseUrl, caPath) {
  const url = new URL(baseUrl);

  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ scenarios: ['manual/web-ui'] });
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port),
      servername: url.hostname,
      ca: readFileSync(caPath),
    });
    let responseBytes = 0;

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 5_000);

    socket.once('secureConnect', () => {
      socket.write([
        'POST /v1/watchers/login HTTP/1.1',
        `Host: ${url.host}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      responseBytes += chunk.length;
    });
    socket.once('end', () => {
      clearTimeout(timeout);
      if (responseBytes > 0) {
        reject(new Error('CrowdSec returned an HTTP response without a client certificate.'));
        return;
      }
      resolve();
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function assertCrowdSecRegisteredTlsMachine(container) {
  const output = run('docker', ['exec', container, 'cscli', 'machines', 'list', '-o', 'json']);
  const normalized = output.toLowerCase();

  if (!normalized.includes(machineCommonName) || !normalized.includes('tls')) {
    throw new Error(`CrowdSec did not report the expected TLS machine.\n${output}`);
  }
}

async function main() {
  ensureCommand('docker');
  ensureCommand('openssl');

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'crowdsec-web-ui-mtls-'));
  let containerStarted = false;

  try {
    generateCertificates(workDir);
    writeCrowdSecTlsOverride(workDir);

    console.log(`Starting disposable CrowdSec container: ${containerName}`);
    run('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-e',
      'DISABLE_AGENT=true',
      '-e',
      'DISABLE_ONLINE_API=true',
      '-p',
      '127.0.0.1::8080',
      '-v',
      `${workDir}:/mtls:ro`,
      '-v',
      `${path.join(workDir, 'config.yaml.local')}:/etc/crowdsec/config.yaml.local:ro`,
      image,
    ]);
    containerStarted = true;

    const publishedPort = parsePublishedPort(run('docker', ['port', containerName, '8080/tcp']));
    const crowdsecUrl = `https://localhost:${publishedPort}`;
    const createClient = () =>
      new LapiClient({
        crowdsecUrl,
        auth: {
          mode: 'mtls',
          certPath: path.join(workDir, 'agent.pem'),
          keyPath: path.join(workDir, 'agent-key.pem'),
          caCertPath: path.join(workDir, 'ca.pem'),
        },
        simulationsEnabled: true,
        lookbackPeriod: '1h',
        version: 'mtls-smoke',
      });

    const client = await waitForLogin(createClient, containerName);
    const alertsResponse = await client.fetchLapi('/v1/alerts?since=1h&limit=0');
    if (alertsResponse.status !== 200) {
      throw new Error(`Expected CrowdSec alerts endpoint to return HTTP 200, got: ${alertsResponse.status}`);
    }

    await assertNoClientCertificateIsRejected(crowdsecUrl, path.join(workDir, 'ca.pem'));
    assertCrowdSecRegisteredTlsMachine(containerName);

    console.log(`CrowdSec mTLS smoke test passed against ${image} on ${crowdsecUrl}`);
  } finally {
    if (containerStarted && !keepContainer) {
      runQuiet('docker', ['rm', '-f', containerName]);
    } else if (containerStarted) {
      console.log(`Keeping CrowdSec container for inspection: ${containerName}`);
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => {
  console.error('CrowdSec mTLS smoke test timed out.');
  process.exit(1);
}, 120_000);

main()
  .then(() => {
    clearTimeout(watchdog);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  });
