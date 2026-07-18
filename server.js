-/**
 * Backend Node.js/Express — build APK via GitHub Actions + Supabase Storage
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ============ CONFIG SUPABASE ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BUCKET = "apk-builds";

// ============ CONFIG GITHUB ============
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL;

// ============ SUIVI DES BUILDS ============
const builds = new Map();

// ============ ROUTES ============

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/test-storage", async (req, res) => {
  try {
    const testKey = `test-${Date.now()}.txt`;
    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(testKey, Buffer.from("Hello from VoltBuilder"), {
        contentType: "text/plain",
      });
    
    if (upError) throw upError;
    
    const { error: delError } = await supabase.storage
      .from(BUCKET)
      .remove([testKey]);
    
    if (delError) throw delError;
    
    res.json({ ok: true, message: "Supabase Storage OK" });
  } catch (err) {
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
    // 1. Upload du zip sur Supabase
    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(zipKey, req.file.buffer, {
        contentType: "application/zip",
      });
    
    if (upError) throw upError;

    // 2. URL signee pour telecharger le zip (1h)
    const { data: zipUrlData, error: zipUrlError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(zipKey, 3600);
    
    if (zipUrlError) throw zipUrlError;
    const zipDownloadUrl = zipUrlData.signedUrl;

    // 3. URL signee pour uploader l'APK (1h)
    const { data: apkUrlData, error: apkUrlError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(apkKey, 3600);
    
    if (apkUrlError) throw apkUrlError;
    const apkUploadUrl = apkUrlData.signedUrl;

    // 4. Declenche GitHub Actions
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
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
      throw new Error(`GitHub refused: ${dispatchRes.status}`);
    }

    res.json({ buildId, message: "Build lance." });

    // Nettoyage auto apres 2h
    setTimeout(async () => {
      await supabase.storage.from(BUCKET).remove([zipKey, apkKey]).catch(() => {});
      builds.delete(buildId);
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    builds.set(buildId, { state: "error", message: err.message });
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/build/:id/callback", (req, res) => {
  const { state, message } = req.body;
  const build = builds.get(req.params.id);
  if (build) builds.set(req.params.id, { ...build, state, message });
  res.sendStatus(200);
});

app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ state: "error", message: "Build introuvable." });
  res.json(build);
});

app.get("/api/build/:id/download", async (req, res) => {
  const apkKey = `${req.params.id}/app-debug.apk`;
  
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(apkKey, 300);
    
    if (error) throw error;
    res.redirect(data.signedUrl);

    setTimeout(async () => {
      await supabase.storage.from(BUCKET).remove([apkKey]).catch(() => {});
      builds.delete(req.params.id);
    }, 5 * 60 * 1000);
  } catch (err) {
    res.status(404).json({ message: "APK introuvable." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend pret sur :${PORT}`));
