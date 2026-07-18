/**
 * Backend Node.js/Express — build APK via GitHub Actions + Cloudflare R2.
 * SANS SDK AWS — utilise fetch natif pour éviter les problèmes SSL
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID, createHmac, createHash } from "crypto";
import { Buffer } from "buffer";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ============ CONFIG R2 ============
const R2_ACCOUNT_ID = "6d38332d43a0646b19db772a01d85515";
const R2_ACCESS_KEY_ID = "1ce3e2b243260468d73fc4309b15dc75";
const R2_SECRET_ACCESS_KEY = "cfat_VKbXDuJHBLQpusGBWA7IaF5Udw1fhX62ATaBBXL75fb9b603";
const BUCKET = "apk-builder";

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// ============ CONFIG GITHUB ============
const GITHUB_OWNER = "henockagbo4-creator";
const GITHUB_REPO = "build";
const GITHUB_TOKEN = "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";
const PUBLIC_BACKEND_URL = "https://build-production-89f7.up.railway.app";

// ============ SUIVI DES BUILDS ============
const builds = new Map();

// ============ FONCTIONS R2 (fetch natif) ============

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  let kDate = createHmac('sha256', 'AWS4' + key).update(dateStamp).digest();
  let kRegion = createHmac('sha256', kDate).update(regionName).digest();
  let kService = createHmac('sha256', kRegion).update(serviceName).digest();
  let kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  return kSigning;
}

async function r2PutObject(key, body, contentType) {
  const method = 'PUT';
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '') + 'Z';
  const dateStamp = amzDate.substr(0, 8);
  
  const payloadHash = createHash('sha256').update(body).digest('hex');
  
  const headers = {
    'host': `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'content-type': contentType,
  };
  
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
  
  const canonicalRequest = [
    method,
    `/${BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');
  
  const signingKey = getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  
  const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  const response = await fetch(`${R2_ENDPOINT}/${BUCKET}/${key}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Authorization': authHeader,
      'Content-Length': body.length.toString(),
    },
    body: body,
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 PUT failed: ${response.status} — ${text}`);
  }
  
  return true;
}

async function r2GetObject(key) {
  const method = 'GET';
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '') + 'Z';
  const dateStamp = amzDate.substr(0, 8);
  
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // empty string hash
  
  const headers = {
    'host': `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
  
  const canonicalRequest = [
    method,
    `/${BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');
  
  const signingKey = getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  
  const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  const url = new URL(`${R2_ENDPOINT}/${BUCKET}/${key}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${R2_ACCESS_KEY_ID}/${credentialScope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', '3600');
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);
  url.searchParams.set('X-Amz-Signature', signature);
  
  return url.toString();
}

async function r2DeleteObject(key) {
  const method = 'DELETE';
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '') + 'Z';
  const dateStamp = amzDate.substr(0, 8);
  
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  
  const headers = {
    'host': `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
  
  const canonicalRequest = [
    method,
    `/${BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');
  
  const signingKey = getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  
  const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  const response = await fetch(`${R2_ENDPOINT}/${BUCKET}/${key}`, {
    method: 'DELETE',
    headers: {
      ...headers,
      'Authorization': authHeader,
    },
  });
  
  return response.ok;
}

// ============ ROUTES ============

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/test-r2", async (req, res) => {
  try {
    const testKey = `test-${Date.now()}.txt`;
    await r2PutObject(testKey, Buffer.from("Hello from VoltBuilder"), "text/plain");
    await r2DeleteObject(testKey);
    res.json({ ok: true, message: "R2 read/write OK" });
  } catch (err) {
    console.error("R2 test failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/build", upload.single("zip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Aucun fichier recu." });
  }

  const buildId = randomUUID();
  const zipKey = `${buildId}/source.zip`;
  const apkKey = `${buildId}/app-debug.apk`;

  builds.set(buildId, { state: "building", createdAt: Date.now() });

  try {
    // 1. Upload du zip
    await r2PutObject(zipKey, req.file.buffer, "application/zip");

    // 2. URL signée pour télécharger le zip
    const zipDownloadUrl = await r2GetObject(zipKey);

    // 3. URL signée pour uploader l'APK
    const apkUploadUrl = await r2GetObject(apkKey);

    // 4. Déclenche GitHub Actions
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            zip_url: zipDownloadUrl,
            app_name: req.body.appName || "MonApp",
            package_id: req.body.packageId || "com.exemple.monapp",
            upload_url: apkUploadUrl,
            build_id: buildId,
            callback_url: `${PUBLIC_BACKEND_URL}/api/build/${buildId}/callback`,
          },
        }),
      }
    );

    if (!dispatchRes.ok) {
      const ghError = await dispatchRes.text();
      throw new Error(`GitHub refused: ${dispatchRes.status} — ${ghError}`);
    }

    res.json({ buildId, message: "Build lance." });

    setTimeout(async () => {
      try { await r2DeleteObject(zipKey); } catch (e) {}
      try { await r2DeleteObject(apkKey); } catch (e) {}
      builds.delete(buildId);
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error("Build error:", err);
    builds.set(buildId, { state: "error", message: err.message });
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/build/:id/callback", (req, res) => {
  const { state, message } = req.body;
  const build = builds.get(req.params.id);
  if (build) {
    builds.set(req.params.id, { ...build, state, message });
  }
  res.sendStatus(200);
});

app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({
      state: "error",
      message: "Build introuvable ou expire.",
    });
  }
  res.json(build);
});

app.get("/api/build/:id/download", async (req, res) => {
  const apkKey = `${req.params.id}/app-debug.apk`;

  try {
    const url = await r2GetObject(apkKey);
    res.redirect(url);

    setTimeout(async () => {
      try { await r2DeleteObject(apkKey); } catch (e) {}
      builds.delete(req.params.id);
    }, 5 * 60 * 1000);
  } catch (err) {
    res.status(404).json({ message: "APK introuvable ou deja supprimee." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend pret sur le port ${PORT}`);
});
