const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function writeJSON(file, data) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function uuid() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// In-memory OAuth token cache  { profileId: { access_token, expires_at } }
// ---------------------------------------------------------------------------
const tokenCache = {};

// ---------------------------------------------------------------------------
// Profile CRUD  (data/profiles.json)
// ---------------------------------------------------------------------------
app.get('/api/profiles', (_req, res) => {
  res.json(readJSON('profiles.json'));
});

app.post('/api/profiles', (req, res) => {
  const profiles = readJSON('profiles.json');
  const body = req.body;
  if (body.id) {
    const idx = profiles.findIndex((p) => p.id === body.id);
    if (idx !== -1) {
      profiles[idx] = { ...profiles[idx], ...body };
      writeJSON('profiles.json', profiles);
      return res.json(profiles[idx]);
    }
  }
  const profile = { id: uuid(), ...body };
  profiles.push(profile);
  writeJSON('profiles.json', profiles);
  res.status(201).json(profile);
});

app.delete('/api/profiles/:id', (req, res) => {
  let profiles = readJSON('profiles.json');
  profiles = profiles.filter((p) => p.id !== req.params.id);
  writeJSON('profiles.json', profiles);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Request collection CRUD  (data/requests.json)
// ---------------------------------------------------------------------------
app.get('/api/requests', (_req, res) => {
  res.json(readJSON('requests.json'));
});

app.post('/api/requests', (req, res) => {
  const requests = readJSON('requests.json');
  const body = req.body;
  if (body.id) {
    const idx = requests.findIndex((r) => r.id === body.id);
    if (idx !== -1) {
      requests[idx] = { ...requests[idx], ...body };
      writeJSON('requests.json', requests);
      return res.json(requests[idx]);
    }
  }
  const entry = { id: uuid(), ...body, createdAt: new Date().toISOString() };
  requests.push(entry);
  writeJSON('requests.json', requests);
  res.status(201).json(entry);
});

app.delete('/api/requests/:id', (req, res) => {
  let requests = readJSON('requests.json');
  requests = requests.filter((r) => r.id !== req.params.id);
  writeJSON('requests.json', requests);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// OAuth 2.0 Client Credentials token fetch
// ---------------------------------------------------------------------------
function fetchOAuthToken(tokenUrl, clientId, clientSecret, scope) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(tokenUrl);
    const postData = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scope) postData.append('scope', scope);
    const postBody = postData.toString();

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
      },
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject({ status: res.statusCode, body: json });
          }
        } catch {
          reject({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

app.post('/api/oauth/token', async (req, res) => {
  try {
    const { tokenUrl, clientId, clientSecret, scope, profileId } = req.body;
    if (!tokenUrl || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'tokenUrl, clientId, and clientSecret are required' });
    }
    const tokenRes = await fetchOAuthToken(tokenUrl, clientId, clientSecret, scope);
    if (profileId && tokenRes.access_token) {
      tokenCache[profileId] = {
        access_token: tokenRes.access_token,
        expires_at: Date.now() + (tokenRes.expires_in || 3600) * 1000,
      };
    }
    res.json(tokenRes);
  } catch (err) {
    res.status(502).json({ error: 'Token fetch failed', details: err });
  }
});

// ---------------------------------------------------------------------------
// Helper: get cached or fresh token for a profile
// ---------------------------------------------------------------------------
async function getTokenForProfile(profile) {
  if (!profile.oauth || !profile.oauth.tokenUrl) return null;

  const cached = tokenCache[profile.id];
  if (cached && cached.expires_at > Date.now() + 30000) {
    return cached.access_token;
  }

  const tokenRes = await fetchOAuthToken(
    profile.oauth.tokenUrl,
    profile.oauth.clientId,
    profile.oauth.clientSecret,
    profile.oauth.scope
  );

  if (tokenRes.access_token) {
    tokenCache[profile.id] = {
      access_token: tokenRes.access_token,
      expires_at: Date.now() + (tokenRes.expires_in || 3600) * 1000,
    };
    return tokenRes.access_token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: safely read a PEM / key file
// ---------------------------------------------------------------------------
function readFileIfExists(filePath) {
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return fs.readFileSync(resolved);
}

// ---------------------------------------------------------------------------
// Proxy endpoint
// ---------------------------------------------------------------------------
app.post('/api/proxy', async (req, res) => {
  const startTime = Date.now();
  try {
    const { url, method, headers: userHeaders, body, profileId } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const parsed = new URL(url);
    let profile = null;

    if (profileId) {
      const profiles = readJSON('profiles.json');
      profile = profiles.find((p) => p.id === profileId);
    }

    // Build https options
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: (method || 'GET').toUpperCase(),
      headers: { ...userHeaders },
    };

    // mTLS certs from profile
    if (profile && profile.mtls) {
      if (profile.mtls.cert) options.cert = readFileIfExists(profile.mtls.cert);
      if (profile.mtls.key) options.key = readFileIfExists(profile.mtls.key);
      if (profile.mtls.ca) options.ca = readFileIfExists(profile.mtls.ca);
      if (profile.mtls.passphrase) options.passphrase = profile.mtls.passphrase;
    }

    // OAuth token
    if (profile) {
      const token = await getTokenForProfile(profile);
      if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // Request body
    let reqBody = null;
    if (body !== undefined && body !== null && body !== '') {
      reqBody = typeof body === 'string' ? body : JSON.stringify(body);
      if (!options.headers['Content-Type'] && !options.headers['content-type']) {
        options.headers['Content-Type'] = 'application/json';
      }
      options.headers['Content-Length'] = Buffer.byteLength(reqBody);
    }

    const transport = parsed.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(options, (proxyRes) => {
      let data = [];
      proxyRes.on('data', (chunk) => data.push(chunk));
      proxyRes.on('end', () => {
        const buffer = Buffer.concat(data);
        const elapsed = Date.now() - startTime;
        const responseHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          responseHeaders[k] = v;
        }

        let bodyStr = buffer.toString('utf-8');
        let bodyParsed = bodyStr;
        try {
          bodyParsed = JSON.parse(bodyStr);
        } catch {
          // keep as string
        }

        res.json({
          status: proxyRes.statusCode,
          statusMessage: proxyRes.statusMessage,
          headers: responseHeaders,
          body: bodyParsed,
          size: buffer.length,
          time: elapsed,
        });
      });
    });

    proxyReq.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      res.status(502).json({
        error: err.message,
        code: err.code,
        time: elapsed,
      });
    });

    if (reqBody) proxyReq.write(reqBody);
    proxyReq.end();
  } catch (err) {
    const elapsed = Date.now() - startTime;
    res.status(500).json({ error: err.message, time: elapsed });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  ensureDataDir();
  console.log(`mTLS API Client running at http://localhost:${PORT}`);
});
