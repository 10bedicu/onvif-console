// Generates README screenshots by driving the live console with a system
// Chrome. Requires the sidecar running on :5800 and a camera connected.
//   node scripts/screenshots.mjs
import puppeteer from "puppeteer-core";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:5800";
const OUT = path.resolve("docs/screenshots");

async function clickByText(page, text) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((n) =>
      n.textContent.trim().toLowerCase().includes(t.toLowerCase()),
    );
    if (el) el.click();
  }, text);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,1024",
  ],
  defaultViewport: { width: 1440, height: 1024, deviceScaleFactor: 2 },
});

const page = await browser.newPage();

async function shot(name, { fullPage = true } = {}) {
  await page.screenshot({ path: path.join(OUT, name), fullPage });
  console.log("saved", name);
}

// 1. Connect screen (disconnect first for a clean shot)
await page.goto(BASE, { waitUntil: "networkidle2" });
await sleep(1500);
await fetch(`${BASE}/api/disconnect`, { method: "POST" }).catch(() => {});
await page.reload({ waitUntil: "networkidle2" });
await sleep(1000);
// pre-fill the form so the shot is illustrative
await page.evaluate(() => {
  const set = (ph, v) => {
    const i = [...document.querySelectorAll("input")].find(
      (n) => n.placeholder?.toLowerCase().includes(ph),
    );
    if (i) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(i, v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  set("hostname", "192.168.165.126");
  set("username", "admin");
  set("password", "••••••••");
});
await sleep(400);
await shot("01-connect.png", { fullPage: false });

// 2. Reconnect for the live console
await fetch(`${BASE}/api/connect`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    host: "192.168.165.126",
    port: 80,
    username: "admin",
    password: "Ohcn@123",
  }),
});
await page.goto(BASE, { waitUntil: "networkidle2" });
await sleep(9000); // let live video connect
await shot("02-console-light.png");

// 3. Dark mode
await page.emulateMediaFeatures([
  { name: "prefers-color-scheme", value: "dark" },
]);
await sleep(1500);
await shot("03-console-dark.png");

// 4. Run all tests, capture mid-run (streaming logs + progress)
await page.emulateMediaFeatures([
  { name: "prefers-color-scheme", value: "light" },
]);
await sleep(500);
await clickByText(page, "Run all tests");
await sleep(11000); // a few tests in, one running with live logs
await shot("04-test-run.png");

// 5. Wait for the run to finish, then the report
for (let i = 0; i < 60; i++) {
  const running = await page.evaluate(() =>
    document.body.textContent.includes("Cancel run"),
  );
  if (!running) break;
  await sleep(2000);
}
await sleep(1500);
await page.goto(`${BASE}/report/`, { waitUntil: "networkidle2" });
await sleep(1500);
await shot("05-report.png");

await browser.close();
console.log("done");
