const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');
const path = require('path');

const https = require('https');
const selfsigned = require('selfsigned');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// Configuration
const PORT = process.env.PORT || 3001;
const CROWDSEC_CONTAINER = process.env.CROWDSEC_CONTAINER || 'crowdsec';
const AGENT_TOKEN = process.env.AGENT_TOKEN;

const HTTPS_CERT_FILE = process.env.HTTPS_CERT_FILE || path.join(__dirname, 'certs', 'server.cert');
const HTTPS_KEY_FILE = process.env.HTTPS_KEY_FILE || path.join(__dirname, 'certs', 'server.key');

// Validation
if (!AGENT_TOKEN) {
    console.error("FATAL: AGENT_TOKEN environment variable is not set.");
    process.exit(1);
}

// Docker Client
// Docker Client Configuration
// fs is already imported at the top

let dockerConfig = { socketPath: '/var/run/docker.sock' };

if (process.env.DOCKER_HOST) {
    console.log('Using custom Docker Host:', process.env.DOCKER_HOST);

    // Construct simplified config for dockerode
    // If DOCKER_HOST is provided, we ignore socketPath
    dockerConfig = {
        host: process.env.DOCKER_HOST,
        port: process.env.DOCKER_PORT || 2375, // Default non-TLS port, usually 2376 for TLS but let user override
        protocol: 'https', // Assume HTTPS if certs are present, logic below refines this
    };

    // Helper to read file if it exists, with smart path resolution
    const readFile = (filePath) => {
        if (!filePath) return null;
        try {
            // 1. Try absolute or direct relative path
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath);
            }

            // 2. Try looking in parent dir (useful when running from agent/ subdir but configured from root)
            // Note: __dirname is the directory of index.js (agent/)
            const parentRelativePath = path.join(__dirname, '..', filePath);
            if (fs.existsSync(parentRelativePath)) {
                console.log(`Resolved certificate at: ${parentRelativePath}`);
                return fs.readFileSync(parentRelativePath);
            }

            console.warn(`Warning: Certificate file not found at ${filePath} or ${parentRelativePath}`);
            return null;
        } catch (e) {
            console.error(`Error reading certificate ${filePath}:`, e.message);
            return null;
        }
    };

    const ca = readFile(process.env.DOCKER_CAFILE);
    const cert = readFile(process.env.DOCKER_CERTFILE);
    const key = readFile(process.env.DOCKER_KEYFILE);

    if (ca || cert || key) {
        dockerConfig.ca = ca;
        dockerConfig.cert = cert;
        dockerConfig.key = key;
        dockerConfig.protocol = 'https';
    } else {
        dockerConfig.protocol = 'http';
    }

    if (process.env.DOCKER_TLS_VERIFY === 'false') {
        console.log('DISABLING TLS VERIFICATION');
        dockerConfig.rejectUnauthorized = false;
        dockerConfig.checkServerIdentity = () => undefined;
    }
}

const docker = new Docker(dockerConfig);

// Middleware: Authentication
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== AGENT_TOKEN) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }
    next();
};

app.use(authenticate);

// Helper: Execute Command in Container
async function execCommand(command) {
    try {
        const container = docker.getContainer(CROWDSEC_CONTAINER);

        // Inspect to verify container exists and is running
        const info = await container.inspect();
        if (!info.State.Running) {
            throw new Error(`Container ${CROWDSEC_CONTAINER} is not running`);
        }

        const exec = await container.exec({
            Cmd: ['sh', '-c', command],
            AttachStdout: true,
            AttachStderr: true
        });

        const stream = await exec.start();

        let output = '';
        let errorOutput = '';

        // Dockerode stream handling (demultiplexing)
        await new Promise((resolve, reject) => {
            container.modem.demuxStream(stream, {
                write: (chunk) => { output += chunk.toString('utf8'); },
            }, {
                write: (chunk) => { errorOutput += chunk.toString('utf8'); }
            });
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        // Check exit code
        const inspect = await exec.inspect();
        if (inspect.ExitCode !== 0) {
            throw new Error(`Command failed (Exit Code ${inspect.ExitCode}): ${errorOutput || output}`);
        }

        return output.trim();
    } catch (error) {
        console.error(`Exec Error: ${error.message}`);
        throw error;
    }
}

// --- Endpoints ---

// GET /alerts
app.get('/alerts', async (req, res) => {
    try {
        const { limit, since, until, type } = req.query;
        let cmd = `cscli alerts list -o json`;

        if (limit) cmd += ` --limit ${limit}`;
        if (since) cmd += ` --since ${since}`;
        if (until) cmd += ` --until ${until}`;
        if (type) cmd += ` --type ${type}`;
        // Note: 'status' is NOT supported by cscli alerts list

        console.log(`Executing: ${cmd}`);
        const result = await execCommand(cmd);

        try {
            const json = JSON.parse(result || '[]');
            res.json(json);
        } catch (e) {
            console.error("Failed to parse JSON:", result);
            res.status(500).json({ error: 'Failed to parse JSON response from cscli' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /alerts/:id
app.delete('/alerts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cmd = `cscli alerts delete --id ${id} -o json`;
        console.log(`Executing: ${cmd}`);

        await execCommand(cmd);
        res.json({ success: true, message: `Alert ${id} deleted` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /decisions
app.get('/decisions', async (req, res) => {
    try {
        const { limit, ip, range, type, value, scope, scenario, since, until, contained } = req.query;
        let cmd = `cscli decisions list -o json`;

        if (limit) cmd += ` --limit ${limit}`;
        if (ip) cmd += ` --ip ${ip}`;
        if (range) cmd += ` --range ${range}`;
        if (type) cmd += ` --type ${type}`;
        if (value) cmd += ` --value ${value}`;
        if (scope) cmd += ` --scope ${scope}`;
        if (scenario) cmd += ` --scenario ${scenario}`;
        if (since) cmd += ` --since ${since}`;
        if (until) cmd += ` --until ${until}`;
        if (contained) cmd += ` --contained`;

        console.log(`Executing: ${cmd}`);
        const result = await execCommand(cmd);

        try {
            const json = JSON.parse(result || '[]');
            res.json(json);
        } catch (e) {
            console.error("Failed to parse JSON:", result);
            res.status(500).json({ error: 'Failed to parse JSON response from cscli' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /decisions (Add Decision)
app.post('/decisions', async (req, res) => {
    try {
        const { ip, range, type, duration, reason } = req.body;
        if (!ip && !range) return res.status(400).json({ error: 'IP or Range required' });

        const typeArg = type ? `--type ${type}` : '';
        const durationArg = duration ? `--duration ${duration}` : ''; // Default is usually 4h
        const reasonArg = reason ? `--reason "${reason}"` : '';
        const target = ip ? `--ip ${ip}` : `--range ${range}`;

        const cmd = `cscli decisions add ${target} ${typeArg} ${durationArg} ${reasonArg}`;
        console.log(`Executing: ${cmd}`);

        const result = await execCommand(cmd);
        res.json({ success: true, output: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /decisions/:id
app.delete('/decisions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cmd = `cscli decisions delete --id ${id}`;
        console.log(`Executing: ${cmd}`);
        await execCommand(cmd);
        res.json({ success: true, message: `Decision ${id} deleted` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Allowlist Management (Native cscli allowlists) ---
const ALLOWLIST_NAME = "web-ui-allowlist";

// Helper: Ensure allowlist exists
async function ensureAllowlist() {
    try {
        const listOutput = await execCommand(`cscli allowlists list -o json`);
        let lists = [];
        try {
            lists = JSON.parse(listOutput || '[]');
        } catch (e) {
            // Ignore parse error, maybe empty
        }

        const exists = lists.find(l => l.name === ALLOWLIST_NAME);
        if (!exists) {
            console.log(`Allowlist ${ALLOWLIST_NAME} does not exist. Creating...`);
            await execCommand(`cscli allowlists create ${ALLOWLIST_NAME} --description "Managed by CrowdSec Web UI"`);
            // Reload strictly required? Usually yes for allowlists to be active.
            await execCommand(`kill -HUP 1`);
        }
    } catch (e) {
        console.error("Error creating allowlist:", e);
    }
}

// GET /allowlist
app.get('/allowlist', async (req, res) => {
    try {
        await ensureAllowlist();
        const output = await execCommand(`cscli allowlists inspect ${ALLOWLIST_NAME} -o json`);
        const data = JSON.parse(output || '{}');

        // Inspect returns object with 'items' array
        const items = data.items || [];

        const responseData = items.map(item => {
            // value can be string or object depending on version
            const val = (typeof item === 'object' && item.value) ? item.value : item;

            // Heuristic for type if not explicit
            let type = 'ip';
            if (val && typeof val === 'string' && val.includes('/')) type = 'cidr';

            return {
                value: val,
                type: type,
                created_at: item.created_at,
                description: item.description || item.comment // check for both
            };
        });

        res.json(responseData);
    } catch (error) {
        console.error("Error fetching allowlist:", error);
        res.status(500).json({ error: error.message });
    }
});

// POST /allowlist
app.post('/allowlist', async (req, res) => {
    try {
        const { ip, range, reason } = req.body;
        const value = ip || range;

        if (!value) return res.status(400).json({ error: 'IP or Range required' });

        await ensureAllowlist();

        // cscli allowlists add <name> <val> --comment "..."
        let cmd = `cscli allowlists add ${ALLOWLIST_NAME} ${value}`;
        if (reason) cmd += ` --comment "${reason}"`;

        console.log(`Executing: ${cmd}`);
        await execCommand(cmd);

        await execCommand(`kill -HUP 1`);

        res.json({ success: true, message: 'Added to allowlist' });
    } catch (error) {
        console.error("Error adding to allowlist:", error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE /allowlist
app.delete('/allowlist', async (req, res) => {
    try {
        const { value } = req.body;
        const target = value || req.query.value;

        if (!target) return res.status(400).json({ error: 'Value required' });

        await ensureAllowlist();

        const cmd = `cscli allowlists remove ${ALLOWLIST_NAME} ${target}`;
        console.log(`Executing: ${cmd}`);
        await execCommand(cmd);

        await execCommand(`kill -HUP 1`);

        res.json({ success: true, message: 'Removed from allowlist' });

    } catch (error) {
        console.error("Error removing from allowlist:", error);
        res.status(500).json({ error: error.message });
    }
});


// HTTPS Certificate Management
async function getCertificates() {
    const certDir = path.dirname(HTTPS_CERT_FILE);
    if (!fs.existsSync(certDir)) {
        console.log(`Creating certificate directory at ${certDir}`);
        fs.mkdirSync(certDir, { recursive: true });
    }

    if (fs.existsSync(HTTPS_CERT_FILE) && fs.existsSync(HTTPS_KEY_FILE)) {
        console.log('Loading existing SSL certificates...');
        return {
            key: fs.readFileSync(HTTPS_KEY_FILE),
            cert: fs.readFileSync(HTTPS_CERT_FILE)
        };
    }

    console.log('No certificates found. Generating self-signed certificates...');
    const attrs = [{ name: 'commonName', value: 'localhost' }];

    // selfsigned.generate is async in current versions
    const pems = await selfsigned.generate(attrs, { days: 365 });

    fs.writeFileSync(HTTPS_CERT_FILE, pems.cert);
    fs.writeFileSync(HTTPS_KEY_FILE, pems.private);

    console.log(`Generated self-signed certificates at ${HTTPS_CERT_FILE} and ${HTTPS_KEY_FILE}`);
    return {
        key: pems.private,
        cert: pems.cert
    };
}

async function startServer() {
    try {
        const httpsOptions = await getCertificates();
        https.createServer(httpsOptions, app).listen(PORT, () => {
            console.log(`Agent running on port ${PORT} (HTTPS)`);
        });
    } catch (e) {
        console.error("Failed to start server:", e);
        process.exit(1);
    }
}

startServer();
