// Builds static/apple-touch-icon.png (180x180) from static/icon.svg with Chromium.
// Square corners: iOS applies its own mask, and transparent corners turn black.
// Node, not Deno, because it uses the pre-installed Playwright: node examples/build_touch_icon.cjs
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "static");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8")
  .replace('<rect width="64" height="64" rx="14"', '<rect width="64" height="64"');
if (svg.includes('rx="14"')) throw new Error("icon.svg background changed; update this script");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await page.setContent(
    `<body style="margin:0">${svg.replace("<svg ", '<svg width="180" height="180" ')}</body>`,
  );
  await page.screenshot({ path: path.join(dir, "apple-touch-icon.png"), omitBackground: false });
  await browser.close();
  console.log("Wrote static/apple-touch-icon.png");
})();
