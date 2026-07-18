/**
 * Backend Node.js/Express — build APK via GitHub Actions + Cloudflare R2.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ============ CONFIG R2 (Cloudflare) ============
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_NAME;

// FIX : Config R2 compatible signature
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ============ CONFIG GITHUB ============
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL;

// ============ SUIVI DES BUILDS ============
const builds = new Map();

// ============ ROUTES ============

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Test R2
app.get("/api/test-r2", async (req, res) => {
  try {
    const testKey = `test-${Date.now()}.txt`;
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: testKey,
        Body: "Hello from VoltBuilder",
        ContentType: "text/plain",
      })
    );
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: testKey }));
    res.json({ ok: true, message: "R2 read/write OK" });
  } catch (err) {
    console.error("R2 test failed:", err);
    res.status(500).json({ ok: false, error: err.message, code: err.name });
  }
});

// Lancer un build
app.post("/api/build", upload.single("zip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Aucun fichier recu." });
  }

  const buildId = randomUUID();
  const zipKey = `${buildId}/source.zip`;
  const apkKey = `${buildId}/app-debug.apk`;

  builds.set(buildId, { state: "building", createdAt: Date.now() });

  try {
    // 1. Upload du zip sur R2
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: zipKey,
        Body: req.file.buffer,
        ContentType: "application/zip",
      })
    );

    // 2. URL signee pour telecharger le zip
    const zipDownloadUrl = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: BUCKET, Key: zipKey }),
      { expiresIn: 3600 }
    );

    // 3. URL signee pour uploader l'APK
    const apkUploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: apkKey,
        ContentType: "application/vnd.android.package-archive",
      }),
      { expiresIn: 3600 }
    );

    // 4. Declenche GitHub Actions
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

    // Nettoyage auto apres 2h
    setTimeout(async () => {
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: zipKey }));
      } catch (e) {}
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: apkKey }));
      } catch (e) {}
      builds.delete(buildId);
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error("Build error:", err);
    builds.set(buildId, { state: "error", message: err.message });
    res.status(500).json({ message: err.message });
  }
});

// Callback du workflow GitHub
app.post("/api/build/:id/callback", (req, res) => {
  const { state, message } = req.body;
  const build = builds.get(req.params.id);
  if (build) {
    builds.set(req.params.id, { ...build, state, message });
  }
  res.sendStatus(200);
});

// Statut du build
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

// Telecharger l'APK
app.get("/api/build/:id/download", async (req, res) => {
  const apkKey = `${req.params.id}/app-debug.apk`;

  try {
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: BUCKET, Key: apkKey }),
      { expiresIn: 300 }
    );

    res.redirect(url);

    setTimeout(async () => {
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: apkKey }));
      } catch (e) {}
      builds.delete(req.params.id);
    }, 5 * 60 * 1000);
  } catch (err) {
    res.status(404).json({ message: "APK introuvable ou deja supprimee." });
  }
});

// ============ DEMARRAGE ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend pret sur le port ${PORT}`);
  console.log(`Bucket R2: ${BUCKET || "NON CONFIGURE"}`);
  console.log(`GitHub: ${GITHUB_OWNER}/${GITHUB_REPO || "NON CONFIGURE"}`);
});
