const fs = require("fs");
const path = require("path");
const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

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
        "--autoplay-policy=no-user-gesture-required"
      ]
    });
  }
  return browserPromise;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render/png", async (req, res) => {
  let context;
  let page;

  try {
    const {
      template,
      width = 2160,
      height = 3840,
      transparent = false,
      data = {},
      assets = {},
      options = {}
    } = req.body;

    if (!template) {
      return res.status(400).json({ error: "template is required" });
    }

    const templateDir = path.join(TEMPLATES_ROOT, template);
    const htmlPath = path.join(templateDir, "index.html");

    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({
        error: "TEMPLATE_NOT_FOUND",
        detail: htmlPath
      });
    }

    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: options.deviceScaleFactor || 2
    });

    page = await context.newPage();

    await page.addInitScript((payload) => {
      window.RENDER_DATA = payload.data;
      window.RENDER_ASSETS = payload.assets;
      window.RENDER_OPTIONS = payload.options;
      window.__RENDER_READY__ = false;
    }, { data, assets, options });

    await page.goto(`file://${htmlPath}`, { waitUntil: "domcontentloaded" });

    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    await page.waitForFunction(
      () => window.__RENDER_READY__ === true,
      { timeout: 15000 }
    );

    const frame = page.locator("#frame");
    const png = await frame.screenshot({
      type: "png",
      omitBackground: transparent
    });

    res.setHeader("Content-Type", "image/png");
    res.send(png);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "RENDER_FAILED",
      message: err.message
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Renderer running on port ${PORT}`);
  console.log(`DATA_ROOT=${DATA_ROOT}`);
});
