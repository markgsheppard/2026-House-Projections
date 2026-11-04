// Writes final-forecast.json: the model's projection at its default settings, frozen for the results page.
// Usage: node scripts/freeze_forecast.js  (needs the local Playwright + Chromium used for the site's screenshots)
const fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PW_MODULE || "/opt/npm-tools/node_modules/playwright");
(async () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>', () => "<script>\n" + fs.readFileSync(process.env.D3_PATH || "/home/claude/build/libs/node_modules/d3/dist/d3.min.js", "utf8") + "\n</script>")
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>', () => "<script>\n" + fs.readFileSync(process.env.TOPO_PATH || "/home/claude/build/libs/node_modules/topojson-client/dist/topojson-client.min.js", "utf8") + "\n</script>")
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>', () => "")
    .replace('<script src="data.js"></script>', () => "<script>\n" + fs.readFileSync(path.join(root, "data.js"), "utf8") + "\n</script>")
    .replace('<script src="app.js"></script>', () => "<script>\n" + fs.readFileSync(path.join(root, "app.js"), "utf8") + "\n</script>");
  const tmp = path.join(require("os").tmpdir(), "freeze-" + Date.now() + ".html");
  fs.writeFileSync(tmp, html);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
  const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
  pg.on("pageerror", e => console.error("page error:", e.message));
  await pg.goto("file://" + tmp); await pg.waitForTimeout(1500);
  const snap = await pg.evaluate(() => window.HOUSE_FORECAST_SNAPSHOT());
  await b.close(); fs.unlinkSync(tmp);
  snap.frozenAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, "final-forecast.json"), JSON.stringify(snap));
  console.log("final-forecast.json:", Object.keys(snap.house).length, "districts,", Object.keys(snap.senate).length, "Senate races; House", snap.tally.house, "Senate", snap.tally.senate, "ballot", snap.genericBallot, "->", snap.effectiveBallot);
})();
