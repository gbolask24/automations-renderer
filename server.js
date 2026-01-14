const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const { chromium } = require("playwright");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "20mb" }));

const DATA_ROOT = process.env.DATA_ROOT || "/data";
const TEMPLATES_ROOT = path.join(DATA_ROOT, "templates");

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--allow-file-access-from-files",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  }
  return browserPromise;
}

function normalizeDpr(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function normalizeInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeFloat(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${cmd} failed (code ${code}). ${stderr || stdout}`));
    });
  });
}

async function renderPngBuffer({
  template,
  width,
  height,
  transparent,
  data,
  assets,
  options,
  hideBg = false,
}) {
  let context;
  let page;

  const templateDir = path.join(TEMPLATES_ROOT, template);
  const htmlPath = path.join(templateDir, "index.html");

  if (!fs.existsSync(htmlPath)) {
    const err = new Error(`Template not found at ${htmlPath}`);
    err.code = "TEMPLATE_NOT_FOUND";
    throw err;
  }

  const dpr = normalizeDpr(options?.deviceScaleFactor, 1);
  const browser = await getBrowser();

  context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });

  page = await context.newPage();

  await page.addInitScript(
    (payload) => {
      window.RENDER_DATA = payload.data;
      window.RENDER_ASSETS = payload.assets;
      window.RENDER_OPTIONS = payload.options;
      window.__RENDER_READY__ = false;
    },
    { data, assets, options }
  );

  await page.goto(`file://${htmlPath}`, { waitUntil: "domcontentloaded" });

  // Hide background layer when generating overlay for video
  if (hideBg) {
    await page.addStyleTag({
      content: `
        .bg { display:none !important; }
      `,
    });
  }

  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });

  await page.waitForFunction(() => window.__RENDER_READY__ === true, {
    timeout: 20000,
  });

  const frame = page.locator("#frame");
  const png = await frame.screenshot({
    type: "png",
    omitBackground: transparent,
  });

  await page.close().catch(() => {});
  await context.close().catch(() => {});

  return png;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, dataRoot: DATA_ROOT });
});

app.post("/render/png", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      template,
      width = 2160,
      height = 3840,
      transparent = false,
      data = {},
      assets = {},
      options = {},
    } = body;

    if (!template) return res.status(400).json({ error: "template is required" });

    const png = await renderPngBuffer({
      template,
      width,
      height,
      transparent,
      data,
      assets,
      options,
      hideBg: false,
    });

    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    console.error(err);
    res.status(err.code === "TEMPLATE_NOT_FOUND" ? 404 : 500).json({
      error: "RENDER_FAILED",
      message: err.message,
    });
  }
});

app.post("/render/video", async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const id = crypto.randomBytes(6).toString("hex");

  const overlayPath = path.join(tmpDir, `overlay-${id}.png`);
  const outPath = path.join(tmpDir, `out-${id}.mp4`);

  try {
    const body = req.body || {};
    const {
      template,
      width = 2160,
      height = 3840,
      data = {},
      assets = {},
      options = {},
    } = body;

    if (!template) return res.status(400).json({ error: "template is required" });

    const bgVideo = assets?.backgroundVideo;
    if (!bgVideo) {
      return res.status(400).json({ error: "assets.backgroundVideo is required for /render/video" });
    }
    if (!String(bgVideo).startsWith("file://")) {
      return res.status(400).json({ error: "assets.backgroundVideo must be a file:// URL for /render/video" });
    }

    const fps = normalizeInt(options?.fps, 30);
    const durationSec = normalizeFloat(options?.durationSec, 6);
    const includeAudio = options?.includeAudio === true;

    // 1) Render overlay PNG with transparent background and NO bg layer
    const overlayPng = await renderPngBuffer({
      template,
      width,
      height,
      transparent: true,
      data,
      assets,      // keep assets if you need other assets; bg is hidden via CSS injection
      options: { ...options, deviceScaleFactor: normalizeDpr(options?.deviceScaleFactor, 1) },
      hideBg: true,
    });

    fs.writeFileSync(overlayPath, overlayPng);

    // Convert file URL -> actual path for ffmpeg
    const bgPath = bgVideo.replace("file://", "");

    // 2) Compose background video + overlay into MP4
    // - loop background if short, cut to duration
    // - scale/crop background to exact WxH
    // - overlay full-frame PNG at 0,0
    const filter = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1[bg]`,
      `[bg][1:v]overlay=0:0:format=auto[v]`,
    ].join(";");

    const ffmpegArgs = [
      "-y",
      "-stream_loop", "-1",
      "-i", bgPath,
      "-i", overlayPath,
      "-t", String(durationSec),
      "-r", String(fps),
      "-filter_complex", filter,
      "-map", "[v]",
      ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ];

    await run("ffmpeg", ffmpegArgs, { timeoutMs: 180000 });

    const mp4 = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(mp4);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "RENDER_VIDEO_FAILED",
      message: err.message,
    });
  } finally {
    // cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Renderer running on port ${PORT}`);
  console.log(`DATA_ROOT=${DATA_ROOT}`);
});
