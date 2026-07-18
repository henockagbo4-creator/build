/**
 * Backend Node.js/Express — build APK via GitHub Actions + Cloudflare R2.
 *
 * Flow : upload zip -> R2 -> déclenche GitHub Actions -> APK revient sur R2
 *        -> utilisateur télécharge -> suppression automatique.
 *
 * Toutes les valeurs sensibles viennent de process.env (fichier .env local,
 * jamais commité). Voir .env.example pour la liste des variables requises.
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
const upload = multer({ storage: multer.memoryStorage() });

// --- Config R2 (compatible API S3), lue depuis .env ---
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

// --- Config GitHub Actions, lue depuis .env ---
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Suivi en mémoire des builds en cours (simple pour démarrer ; à remplacer
// par une vraie base de données si tu ajoutes les comptes utilisateurs).
// state: "building" | "success" | "error"
const builds = new Map();

app.use(express.json());

app.post("/api/build", upload.single("zip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Aucun fichier reçu." });
  }

  const buildId = randomUUID();
  const zipKey = `${buildId}/source.zip`;
  const apkKey = `${buildId}/app-debug.apk`;

  builds.set(buildId, { state: "building" });

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

    // 2. URL signée temporaire pour que GitHub Actions télécharge le zip
    const zipDownloadUrl = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: BUCKET, Key: zipKey }),
      { expiresIn: 3600 }
    );

    // 3. URL signée temporaire pour que GitHub Actions upload l'APK
    const apkUploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({ Bucket: BUCKET, Key: apkKey }),
      { expiresIn: 3600 }
    );

    // 4. Déclenche le workflow GitHub Actions
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
            callback_url: `${process.env.PUBLIC_BACKEND_URL}/api/build/${buildId}/callback`,
          },
        }),
      }
    );

    if (!dispatchRes.ok) {
      throw new Error(`GitHub a refusé le déclenchement (${dispatchRes.status})`);
    }

    res.json({ buildId, message: "Build lancé." });

    // 5. Nettoyage de sécurité après 1h, que le build ait réussi ou non
    setTimeout(async () => {
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: zipKey })).catch(() => {});
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: apkKey })).catch(() => {});
      builds.delete(buildId);
    }, 60 * 60 * 1000);
  } catch (err) {
    builds.set(buildId, { state: "error", message: err.message });
    res.status(500).json({ message: err.message });
  }
});

// Le workflow GitHub Actions appelle cet endpoint à la fin du build
// pour indiquer le résultat (succès ou échec). À ajouter comme dernière
// étape dans build-apk.yml avec un curl POST vers cette route.
app.post("/api/build/:id/callback", (req, res) => {
  const { state, message } = req.body;
  builds.set(req.params.id, { state, message });
  res.sendStatus(200);
});

// Le frontend interroge cet endpoint pour savoir où en est le build
app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ state: "error", message: "Build introuvable ou expiré." });
  }
  res.json(build);
});

// Génère un lien de téléchargement temporaire pour l'APK, puis la supprime
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
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: apkKey })).catch(() => {});
      builds.delete(req.params.id);
    }, 5 * 60 * 1000);
  } catch (err) {
    res.status(404).json({ message: "APK introuvable ou déjà supprimée." });
  }
});

app.listen(3000, () => console.log("Backend prêt sur :3000"));
