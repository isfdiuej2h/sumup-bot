import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRIGHT_DATA_ENDPOINT = process.env.BRIGHT_DATA_ENDPOINT; // wss://USERNAME:PASSWORD@brd.superproxy.io:9222

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

  if (!BRIGHT_DATA_ENDPOINT) {
    return res.status(500).json({ error: "BRIGHT_DATA_ENDPOINT environment variable not set" });
  }

  console.log(`[${new Date().toISOString()}] Processing: ${sumupLink} | Amount: ${amount}`);

  let browser;
  try {
    // Connect to Bright Data's remote Scraping Browser
    browser = await chromium.connectOverCDP(BRIGHT_DATA_ENDPOINT);
    const context = await browser.newContext();
    const page = await context.newPage();

    // Track all navigation/redirect URLs
    const visitedUrls = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        visitedUrls.push(frame.url());
        console.log(`  → Navigated to: ${frame.url()}`);
      }
    });

    // Step 1: Open the SumUp amount link
    console.log("  Step 1: Opening SumUp link...");
    await page.goto(sumupLink, { waitUntil: "networkidle", timeout: 30000 });

    // Step 2: Find and fill the amount input field
    console.log("  Step 2: Filling in amount...");

    // SumUp uses various selectors for the amount input — try them all
    const amountSelectors = [
      'input[type="number"]',
      'input[name="amount"]',
      'input[placeholder*="amount" i]',
      'input[placeholder*="Amount" i]',
      'input[data-testid*="amount" i]',
      '.amount-input input',
      'input[class*="amount" i]',
    ];

    let amountInput = null;
    for (const selector of amountSelectors) {
      try {
        amountInput = await page.waitForSelector(selector, { timeout: 3000 });
        if (amountInput) {
          console.log(`  Found amount input with selector: ${selector}`);
          break;
        }
      } catch {
        // Try next selector
      }
    }

    if (!amountInput) {
      // Take a screenshot to help debug
      const screenshot = await page.screenshot({ encoding: "base64" });
      return res.status(422).json({
        error: "Could not find amount input field on the page",
        debug: {
          currentUrl: page.url(),
          screenshot: `data:image/png;base64,${screenshot}`,
        },
      });
    }

    // Clear existing value and type the amount
    await amountInput.click({ clickCount: 3 }); // Select all
    await amountInput.fill(amount.toString());

    // Step 3: Submit the form / trigger redirect
    console.log("  Step 3: Submitting amount...");

    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Pay")',
      'button:has-text("Proceed")',
      'button:has-text("Confirm")',
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
      // Try pressing Enter as fallback
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {}),
        amountInput.press("Enter"),
      ]);
    }

    // Step 4: Capture the final payment URL
    console.log("  Step 4: Capturing payment URL...");
    await page.waitForTimeout(2000); // Small buffer for any JS redirects

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

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       SumUp Payment Link Bot 🤖          ║
║  Powered by Bright Data Scraping Browser ║
╠══════════════════════════════════════════╣
║  Server running on port ${PORT}             ║
║                                          ║
║  POST /generate-payment-link             ║
║    Body: { sumupLink, amount }           ║
║                                          ║
║  GET  /health                            ║
╚══════════════════════════════════════════╝
  `);
});
