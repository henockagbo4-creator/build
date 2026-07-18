/**
 * Backend Node.js/Express — build APK via GitHub Actions
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

app.post("/api/build", upload.single("zip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Aucun fichier recu." });
  }

  const buildId = randomUUID();
  const buildType = req.body.buildType || "debug";
  const keystoreMode = req.body.keystoreMode || "upload";
  const userKeystorePassword = req.body.keystorePassword?.trim() || "PhilTech2026";
  const keystoreAlias = "release";

  builds.set(buildId, { 
    state: "building", 
    createdAt: Date.now(),
    buildType,
    keystoreMode,
    keystoreGenerated: keystoreMode === "generate",
    keystorePassword: userKeystorePassword,
    keystoreAlias
  });

  try {
    // Validation du package ID
    const packageIdRegex = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    const packageId = req.body.packageId || "com.exemple.monapp";
    if (!packageIdRegex.test(packageId)) {
      throw new Error("Package ID invalide. Format attendu: com.exemple.monapp");
    }

    // Upload du zip sur Supabase (URL signée 1h)
    const zipKey = `${buildId}/source.zip`;
    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(zipKey, req.file.buffer, {
        contentType: "application/zip",
      });
    
    if (upError) throw upError;

    const { data: zipUrlData, error: zipUrlError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(zipKey, 3600);
    
    if (zipUrlError) throw zipUrlError;
    const zipDownloadUrl = zipUrlData.signedUrl;

    // Upload keystore utilisateur si fourni
    let userKeystoreUrl = null;
    if (buildType === "release" && keystoreMode === "upload" && req.files?.keystore) {
      const userKeystoreName = `user-keystore-${buildId}.keystore`;
      const { error: ksError } = await supabase.storage
        .from(BUCKET)
        .upload(`${buildId}/${userKeystoreName}`, req.files.keystore[0].buffer, {
          contentType: "application/octet-stream",
        });
      
      if (!ksError) {
        userKeystoreUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${buildId}/${userKeystoreName}`;
      }
    }

    // Déclenche GitHub Actions
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/build-apk.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            zip_url: zipDownloadUrl,
            app_name: req.body.appName || "MonApp",
            package_id: packageId,
            build_id: buildId,
            build_type: buildType,
            keystore_mode: keystoreMode,
            keystore_url: userKeystoreUrl || "",
            keystore_password: userKeystorePassword,
            keystore_alias: keystoreAlias,
            supabase_url: SUPABASE_URL,
            supabase_key: SUPABASE_KEY,
            bucket: BUCKET,
            callback_url: `${PUBLIC_BACKEND_URL}/api/build/${buildId}/callback`,
          },
        }),
      }
    );

    console.log("GitHub dispatch status:", dispatchRes.status);
    if (!dispatchRes.ok) {
      const ghError = await dispatchRes.text();
      console.error("GitHub error:", ghError);
      throw new Error(`GitHub refused: ${dispatchRes.status} - ${ghError}`);
    }

    res.json({ buildId, message: "Build lance." });

    // Nettoyage auto apres 2h
    setTimeout(async () => {
      const keysToRemove = [zipKey, `${buildId}/app.apk`];
      if (keystoreMode === 'generate') {
        keysToRemove.push(`${buildId}/keystore-${buildId}.keystore`);
      }
      await supabase.storage.from(BUCKET).remove(keysToRemove).catch(() => {});
      builds.delete(buildId);
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error("Build error:", err);
    builds.set(buildId, { state: "error", message: err.message });
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/build/:id/callback", (req, res) => {
  const { state, message, download_url } = req.body;
  const build = builds.get(req.params.id);
  if (build) {
    builds.set(req.params.id, { ...build, state, message, downloadUrl: download_url });
  }
  res.sendStatus(200);
});

app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ state: "error", message: "Build introuvable." });
  }
  
  const response = { ...build };
  
  if (build.keystoreGenerated) {
    response.keystoreUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${req.params.id}/keystore-${req.params.id}.keystore`;
    response.keystoreName = `keystore-${req.params.id}.keystore`;
    response.keystorePassword = build.keystorePassword;
    response.keystoreAlias = build.keystoreAlias;
  }
  
  res.json(response);
});

app.get("/api/build/:id/download", async (req, res) => {
  const apkKey = `${req.params.id}/app.apk`;
  
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
app.listen(PORT, () => {
  console.log("Backend pret sur :" + PORT);
});
