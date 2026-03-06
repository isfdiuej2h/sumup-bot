import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BROWSER_ENDPOINT = process.env.BRIGHT_DATA_ENDPOINT;

/**
 * POST /generate-payment-link
 * Body: { sumupLink: "https://pay.sumup.com/...", amount: "25.00" }
 * Returns: { paymentUrl: "https://..." }
 */
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
    const context = await browser.newContext();
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
    await page.waitForTimeout(3000); // Extra wait for JS to render

    // Step 2: Find amount input
    console.log("  Step 2: Filling in amount...");
    const amountSelectors = [
      'input[type="number"]',
      'input[type="text"]',
      'input[name="amount"]',
      'input[placeholder*="amount" i]',
      'input[placeholder*="0.00"]',
      'input[placeholder*="0,00"]',
      'input[data-testid*="amount" i]',
      '.amount-input input',
      'input[class*="amount" i]',
      'input[class*="Amount" i]',
      'input[inputmode="decimal"]',
      'input[inputmode="numeric"]',
    ];

    let amountInput = null;
    for (const selector of amountSelectors) {
      try {
        amountInput = await page.waitForSelector(selector, { timeout: 2000 });
        if (amountInput) {
          console.log(`  Found amount input with selector: ${selector}`);
          break;
        }
      } catch {
        // Try next selector
      }
    }

    if (!amountInput) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      const html = await page.content();
      await browser.close();
      return res.status(422).json({
        error: "Could not find amount input field on the page",
        debug: {
          currentUrl: page.url(),
          screenshot: `data:image/png;base64,${screenshot}`,
          htmlSnippet: html.substring(0, 3000),
        },
      });
    }

    // Fill the amount
    await amountInput.click({ clickCount: 3 });
    await amountInput.fill(amount.toString());
    await page.waitForTimeout(500);

    // Step 3: Submit
    console.log("  Step 3: Submitting amount...");
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Pay")',
      'button:has-text("Proceed")',
      'button:has-text("Confirm")',
      'button:has-text("Continua")',
      'button:has-text("Avanti")',
      '[data-testid*="submit"]',
      '[data-testid*="continue"]',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          console.log(`  Found submit button with selector: ${selector}`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {}),
            btn.click(),
          ]);
          submitted = true;
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!submitted) {
      console.log("  No submit button found, trying Enter key...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {}),
        amountInput.press("Enter"),
      ]);
    }

    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log(`  ✅ Final payment URL: ${finalUrl}`);

    await browser.close();

    return res.json({
      success: true,
      paymentUrl: finalUrl,
      amount: amount,
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

/**
 * POST /debug
 * Takes a screenshot + lists all inputs and buttons found on the page
 * Body: { url: "https://..." }
 */
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

    // Extract all inputs and buttons from the page
    const elements = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map((el) => ({
        type: el.type,
        name: el.name,
        placeholder: el.placeholder,
        id: el.id,
        className: el.className,
        inputmode: el.inputMode,
      }));

      const buttons = Array.from(document.querySelectorAll("button")).map((el) => ({
        type: el.type,
        text: el.innerText?.trim(),
        id: el.id,
        className: el.className,
      }));

      return { inputs, buttons };
    });

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });
    await browser.close();

    return res.json({
      currentUrl: page.url(),
      elements,
      screenshot: `data:image/png;base64,${screenshot}`,
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       SumUp Payment Link Bot 🤖          ║
╠══════════════════════════════════════════╣
║  Server running on port ${PORT}             ║
║                                          ║
║  POST /generate-payment-link             ║
║  POST /debug                             ║
║  GET  /health                            ║
╚══════════════════════════════════════════╝
  `);
});
