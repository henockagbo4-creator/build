import "dotenv/config";
import express from "express";
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
const upload = multer({ storage: multer.memoryStorage() });

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: zipKey,
        Body: req.file.buffer,
        ContentType: "application/zip",
      })
    );

    const zipDownloadUrl = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: BUCKET, Key: zipKey }),
      { expiresIn: 3600 }
    );

    const apkUploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({ Bucket: BUCKET, Key: apkKey }),
      { expiresIn: 3600 }
    );

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

app.post("/api/build/:id/callback", (req, res) => {
  const { state, message } = req.body;
  builds.set(req.params.id, { state, message });
  res.sendStatus(200);
});

app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) {
    return res.status(404).json({ state: "error", message: "Build introuvable ou expiré." });
  }
  res.json(build);
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend prêt sur :${PORT}`));
