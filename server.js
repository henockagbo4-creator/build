app.post("/api/build", upload.single("zip"), async (req, res) => {
  const buildId = randomUUID();
  
  // 1. Upload zip sur Supabase (temporaire, 1h)
  const { data: zipData } = await supabase.storage
    .from(BUCKET)
    .upload(`${buildId}/source.zip`, req.file.buffer, { contentType: "application/zip" });
  
  const { data: signedUrl } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(`${buildId}/source.zip`, 3600);
  
  // 2. Dispatch GitHub Actions
  await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/build-apk.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        zip_url: signedUrl.signedUrl,
        app_name: req.body.appName,
        package_id: req.body.packageId,
        build_id: buildId,
        build_type: req.body.buildType,
        keystore_mode: req.body.keystoreMode,
        keystore_password: req.body.keystorePassword || "PhilTech2026",
        keystore_alias: "release",
        callback_url: `${PUBLIC_BACKEND_URL}/api/build/${buildId}/callback`,
      }
    })
  });
  
  builds.set(buildId, { state: "building", buildType: req.body.buildType });
  res.json({ buildId });
});

app.post("/api/build/:id/callback", async (req, res) => {
  const { state, message, download_url } = req.body;
  builds.set(req.params.id, { ...builds.get(req.params.id), state, message, downloadUrl: download_url });
  res.sendStatus(200);
});

app.get("/api/build/:id/status", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ state: "error" });
  
  res.json({
    state: build.state,
    message: build.message,
    downloadUrl: build.downloadUrl,  // ← URL directe de l'APK
    keystoreGenerated: build.keystoreGenerated,
    keystoreUrl: build.keystoreUrl,
  });
});
