import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BROWSER_ENDPOINT = process.env.BRIGHT_DATA_ENDPOINT;

app.post("/generate-payment-link", async (req, res) => {
  const { sumupLink, amount } = req.body;

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
    const context = await browser.newContext({
      // Use a real browser user agent to help bypass bot detection
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    const visitedUrls = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        visitedUrls.push(frame.url());
        console.log(`  → Navigated to: ${frame.url()}`);
      }
    });

    // Step 1: Open the SumUp link
    console.log("  Step 1: Opening SumUp link...");
    await page.goto(sumupLink, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 2: Fill amount using the exact selector we found
    console.log("  Step 2: Filling in amount...");
    const amountInput = await page.waitForSelector('input[name="amount"]', { timeout: 10000 });

    if (!amountInput) {
      await browser.close();
      return res.status(422).json({ error: "Could not find amount input field" });
    }

    // Click, clear, and type the amount like a real human would
    await amountInput.click({ clickCount: 3 });
    await page.waitForTimeout(200);
    await amountInput.fill("");
    await page.waitForTimeout(200);

    // Type character by character to appear more human
    for (const char of amount.toString()) {
      await amountInput.type(char, { delay: 100 });
    }

    await page.waitForTimeout(500);
    console.log(`  Filled amount: ${amount}`);

    // Step 3: Intercept the API call that SumUp makes on submit
    // Instead of waiting for a page redirect (which reCAPTCHA may block),
    // we listen to network requests for the payment session URL
    let capturedPaymentUrl = null;

    page.on("request", (request) => {
      const url = request.url();
      // SumUp generates a new payment URL via API when amount is submitted
      if (url.includes("pay.sumup.com") && url !== sumupLink && url.includes("amount")) {
        console.log(`  🎯 Captured payment URL from request: ${url}`);
        capturedPaymentUrl = url;
      }
    });

    page.on("response", async (response) => {
      const url = response.url();
      // Watch for SumUp's internal API responses that contain the new payment link
      if (url.includes("api.sumup.com") || url.includes("pay.sumup.com/api")) {
        try {
          const body = await response.json().catch(() => null);
          if (body) {
            console.log(`  📦 API response from: ${url}`);
            console.log(`  📦 Body: ${JSON.stringify(body).substring(0, 200)}`);
            // Look for a payment link in the response body
            const bodyStr = JSON.stringify(body);
            const match = bodyStr.match(/https:\/\/pay\.sumup\.com\/[^"]+/);
            if (match) {
              capturedPaymentUrl = match[0];
              console.log(`  🎯 Found payment URL in response: ${capturedPaymentUrl}`);
            }
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    });

    // Step 4: Click submit and wait
    console.log("  Step 3: Clicking submit...");
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await amountInput.press("Enter");
    }

    // Wait up to 10 seconds for either a redirect or network capture
    console.log("  Step 4: Waiting for redirect or payment URL...");
    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    console.log(`  Final page URL: ${finalUrl}`);

    // Prefer captured URL from network, fallback to page URL
    const paymentUrl = capturedPaymentUrl || (finalUrl !== sumupLink ? finalUrl : null);

    await browser.close();

    if (!paymentUrl) {
      return res.status(422).json({
        error: "Could not capture payment URL. SumUp reCAPTCHA may have blocked the submission.",
        tip: "Try again — reCAPTCHA sometimes passes on retry.",
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
