import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BROWSER_ENDPOINT = process.env.BRIGHT_DATA_ENDPOINT;
const PROXY_URL = process.env.PROXY_URL || null;

// Build the Browserless WSS endpoint with proxy injected as a query param
// Browserless supports: ?--proxy-server=http://host:port
function buildBrowserEndpoint(proxyOverride) {
  const proxy = proxyOverride || PROXY_URL;
  if (!proxy) return BROWSER_ENDPOINT;

  try {
    const proxyUrl = new URL(proxy);
    // Browserless accepts proxy via launch args in the WS URL
    const proxyServer = `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`;
    const base = BROWSER_ENDPOINT.includes("?")
      ? `${BROWSER_ENDPOINT}&`
      : `${BROWSER_ENDPOINT}?`;
    return `${base}--proxy-server=${encodeURIComponent(proxyServer)}`;
  } catch (e) {
    console.log("  Invalid proxy URL, ignoring proxy");
    return BROWSER_ENDPOINT;
  }
}

// If proxy has credentials, inject them via page route auth
async function setupProxyAuth(page, proxyOverride) {
  const proxy = proxyOverride || PROXY_URL;
  if (!proxy) return;
  try {
    const proxyUrl = new URL(proxy);
    if (proxyUrl.username && proxyUrl.password) {
      await page.authenticate({
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      });
    }
  } catch (e) { /* skip */ }
}

app.post("/generate-payment-link", async (req, res) => {
  const { sumupLink, amount, proxy } = req.body;

  if (!sumupLink || !amount) {
    return res.status(400).json({ error: "Missing required fields: sumupLink and amount" });
  }

  if (!BROWSER_ENDPOINT) {
    return res.status(500).json({ error: "BRIGHT_DATA_ENDPOINT environment variable not set" });
  }

  console.log(`[${new Date().toISOString()}] Processing: ${sumupLink} | Amount: ${amount}`);

  let browser;
  try {
    const endpoint = buildBrowserEndpoint(proxy);
    console.log(`  Connecting to: ${endpoint.replace(/token=[^&]+/, "token=***")}`);

    browser = await chromium.connectOverCDP(endpoint);
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Handle proxy auth if credentials provided
    await setupProxyAuth(page, proxy);

    const visitedUrls = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        visitedUrls.push(frame.url());
        console.log(`  → Navigated to: ${frame.url()}`);
      }
    });

    let capturedPaymentUrl = null;
    page.on("response", async (response) => {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("application/json")) {
          const body = await response.json().catch(() => null);
          if (body) {
            const bodyStr = JSON.stringify(body);
            console.log(`  📦 JSON from ${response.url().substring(0, 80)}: ${bodyStr.substring(0, 300)}`);
            const match = bodyStr.match(/https:\\?\/\\?\/pay\.sumup\.com\\?\/[^"\\]+/);
            if (match) {
              capturedPaymentUrl = match[0].replace(/\\\//g, "/");
              console.log(`  🎯 Captured: ${capturedPaymentUrl}`);
            }
          }
        }
      } catch (e) { /* skip */ }
    });

    // Step 1: Open page
    await page.goto(sumupLink, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 2: Fill amount
    const amountInput = await page.waitForSelector('input[name="amount"]', { timeout: 10000 });
    await amountInput.click({ clickCount: 3 });
    await page.waitForTimeout(300);
    await amountInput.fill("");
    for (const char of amount.toString()) {
      await amountInput.type(char, { delay: 150 });
    }
    await page.waitForTimeout(1000);

    // Step 3: Try reCAPTCHA solver
    try {
      await page.evaluate(() => window.browserlessRecaptcha?.solve?.());
      await page.waitForTimeout(5000);
    } catch (e) { /* skip */ }

    // Step 4: Submit
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {}),
        submitBtn.click(),
      ]);
    } else {
      await amountInput.press("Enter");
    }

    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    const redirected = finalUrl !== sumupLink && finalUrl !== "about:blank";
    const paymentUrl = capturedPaymentUrl || (redirected ? finalUrl : null);

    await browser.close();

    if (!paymentUrl) {
      return res.status(422).json({
        error: "Could not capture payment URL — reCAPTCHA likely blocked submission.",
        visitedUrls,
      });
    }

    return res.json({
      success: true,
      paymentUrl,
      amount,
      originalLink: sumupLink,
      redirectChain: visitedUrls,
    });

  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: "Browser automation failed",
      message: error.message,
    });
  }
});

app.post("/debug", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });
  let browser;
  try {
    browser = await chromium.connectOverCDP(BROWSER_ENDPOINT);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);
    const elements = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map((el) => ({
        type: el.type, name: el.name, placeholder: el.placeholder,
        id: el.id, className: el.className, inputmode: el.inputMode,
      }));
      const buttons = Array.from(document.querySelectorAll("button")).map((el) => ({
        type: el.type, text: el.innerText?.trim(), id: el.id, className: el.className,
      }));
      return { inputs, buttons };
    });
    await browser.close();
    return res.json({ currentUrl: page.url(), elements });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: error.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       SumUp Payment Link Bot 🤖          ║
╠══════════════════════════════════════════╣
║  Server running on port ${PORT}             ║
║  POST /generate-payment-link             ║
║  POST /debug                             ║
║  GET  /health                            ║
╚══════════════════════════════════════════╝
  `);
});
