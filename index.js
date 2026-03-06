import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BROWSER_ENDPOINT = process.env.BRIGHT_DATA_ENDPOINT;

// Optional: your own SOCKS5 proxy
// Format in env: socks5://username:password@host:port
// Or without auth: socks5://host:port
const PROXY_URL = process.env.PROXY_URL || null;

function buildContextOptions() {
  const options = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };

  if (PROXY_URL) {
    console.log(`  Using proxy: ${PROXY_URL.replace(/:\/\/.*@/, "://***@")}`); // hide credentials in logs
    const proxyUrl = new URL(PROXY_URL);
    options.proxy = {
      server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
      ...(proxyUrl.username && { username: decodeURIComponent(proxyUrl.username) }),
      ...(proxyUrl.password && { password: decodeURIComponent(proxyUrl.password) }),
    };
  }

  return options;
}

app.post("/generate-payment-link", async (req, res) => {
  const { sumupLink, amount, proxy } = req.body;

  // Allow per-request proxy override via body
  const proxyToUse = proxy || PROXY_URL;

  if (!sumupLink || !amount) {
    return res.status(400).json({ error: "Missing required fields: sumupLink and amount" });
  }

  if (!BROWSER_ENDPOINT) {
    return res.status(500).json({ error: "BRIGHT_DATA_ENDPOINT environment variable not set" });
  }

  console.log(`[${new Date().toISOString()}] Processing: ${sumupLink} | Amount: ${amount}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(BROWSER_ENDPOINT);

    // Build context with optional proxy
    const contextOptions = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    if (proxyToUse) {
      console.log(`  Using proxy: ${proxyToUse.replace(/:\/\/.*@/, "://***@")}`);
      const proxyUrl = new URL(proxyToUse);
      contextOptions.proxy = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        ...(proxyUrl.username && { username: decodeURIComponent(proxyUrl.username) }),
        ...(proxyUrl.password && { password: decodeURIComponent(proxyUrl.password) }),
      };
    } else {
      console.log("  No proxy configured — using Browserless default IP");
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const visitedUrls = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        visitedUrls.push(frame.url());
        console.log(`  → Navigated to: ${frame.url()}`);
      }
    });

    // Capture payment URL from network responses
    let capturedPaymentUrl = null;
    page.on("response", async (response) => {
      const url = response.url();
      try {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("application/json")) {
          const body = await response.json().catch(() => null);
          if (body) {
            const bodyStr = JSON.stringify(body);
            console.log(`  📦 JSON from ${url.substring(0, 80)}: ${bodyStr.substring(0, 300)}`);
            const match = bodyStr.match(/https:\\?\/\\?\/pay\.sumup\.com\\?\/[^"\\]+/);
            if (match) {
              capturedPaymentUrl = match[0].replace(/\\\//g, "/");
              console.log(`  🎯 Found URL in response: ${capturedPaymentUrl}`);
            }
          }
        }
      } catch (e) { /* skip */ }
    });

    // Step 1: Open page
    console.log("  Step 1: Opening SumUp link...");
    await page.goto(sumupLink, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 2: Fill amount
    console.log("  Step 2: Filling in amount...");
    const amountInput = await page.waitForSelector('input[name="amount"]', { timeout: 10000 });
    await amountInput.click({ clickCount: 3 });
    await page.waitForTimeout(300);
    await amountInput.fill("");
    for (const char of amount.toString()) {
      await amountInput.type(char, { delay: 150 });
    }
    await page.waitForTimeout(1000);

    // Step 3: Try reCAPTCHA solver
    console.log("  Step 3: Attempting reCAPTCHA solve...");
    try {
      await page.evaluate(() => window.browserlessRecaptcha?.solve?.());
      await page.waitForTimeout(5000);
    } catch (e) {
      console.log("  reCAPTCHA solver not triggered");
    }

    // Step 4: Submit
    console.log("  Step 4: Submitting...");
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
        tip: "Try passing a high-quality SOCKS5 proxy in the request body: { proxy: 'socks5://user:pass@host:port' }",
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

// Debug endpoint
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

