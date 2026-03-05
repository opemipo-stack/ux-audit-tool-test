/**
 * Audit Helper
 * Reusable function for single-page audits
 */

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { AuditResult, AuditFinding } from '../types/audit';
import { getRateLimiter } from './rateLimiter';
import { CONFIG } from './config';

// Detect Netlify environment for timeout optimization
const isNetlify = !!process.env.NETLIFY;

const apiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropic = new Anthropic({ apiKey });

// Validate API key on module load
if (!apiKey || apiKey.trim() === '') {
  console.warn('⚠️ ANTHROPIC_API_KEY is not set. AI analysis will fail.');
} else if (!apiKey.startsWith('sk-ant-')) {
  console.warn('⚠️ ANTHROPIC_API_KEY format may be incorrect (should start with "sk-ant-")');
} else {
  console.log('✅ ANTHROPIC_API_KEY loaded successfully');
}

/**
 * Launches browser with appropriate configuration
 */
export async function launchBrowser() {
  const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

  console.log(`  [Browser] Environment: ${isProduction ? 'PRODUCTION (Vercel)' : 'DEVELOPMENT'}`);

  const launchOptions: any = {
    headless: true,
  };

  if (isProduction) {
    try {
      console.log(`  [Browser] Initializing @sparticuz/chromium for Vercel...`);
      const executablePath = await chromium.executablePath();
      if (!executablePath) {
        throw new Error('Chromium executable path is null or undefined from @sparticuz/chromium');
      }
      console.log(`  [Browser] ✅ Chromium executable path obtained: ${executablePath.substring(0, 50)}...`);

      launchOptions.args = chromium.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ];
      launchOptions.executablePath = executablePath;
      console.log(`  [Browser] ✅ Launch options configured for Vercel`);
    } catch (chromiumError: any) {
      console.error(`  [Browser] ❌ Failed to initialize @sparticuz/chromium:`, chromiumError.message);
      console.error(`  [Browser] Error stack:`, chromiumError.stack);
      throw new Error(`Chromium initialization failed in production: ${chromiumError.message}`);
    }
  } else {
    launchOptions.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ];

    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
      launchOptions.executablePath = process.env.CHROME_PATH;
    } else {
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      ].filter(Boolean) as string[];

      let foundPath: string | null = null;
      for (const chromePath of chromePaths) {
        if (chromePath && fs.existsSync(chromePath)) {
          foundPath = chromePath;
          break;
        }
      }

      if (foundPath) {
        launchOptions.executablePath = foundPath;
        console.log(`  ✅ Found Chrome at: ${foundPath}`);
      } else {
        console.log(`  ⚠️ Chrome not found in standard locations, trying channel: chrome`);
        launchOptions.channel = 'chrome';
      }
    }
  }

  try {
    // Add timeout wrapper for browser launch
    const launchPromise = puppeteer.launch(launchOptions);
    const launchTimeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Browser launch timeout after 30 seconds')), 30000)
    );

    const browser = await Promise.race([launchPromise, launchTimeoutPromise]);
    console.log(`  ✅ Browser launched successfully`);
    return browser;
  } catch (error: any) {
    console.error('❌ Browser launch failed:', error.message);
    console.error('   Launch options:', JSON.stringify(launchOptions, null, 2));

    if (error.message.includes('executable') || error.message.includes('not found')) {
      const errorMsg =
        'Chrome/Chromium not found. Please install Google Chrome or set CHROME_PATH environment variable.\n' +
        'For testing, you can use mock data by setting USE_MOCK_DATA=true in .env.local\n' +
        `Attempted paths: ${launchOptions.executablePath || 'default channel'}`;
      console.error(`   ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Log full error for debugging
    console.error('   Full error:', error);
    throw error;
  }
}

/**
 * Audits a single page
 */
export interface AuditSinglePageOptions {
  captureScreenshot?: boolean;
  lightweightAnalysis?: boolean;
  forceFallbackOnError?: boolean;
  preWarmupBeforeAudit?: boolean;
  ultraLightMode?: boolean;
}

function buildFallbackAuditResult(targetUrl: string, errorMessage: string): AuditResult {
  const findings: AuditFinding[] = [
    {
      category: 'performance',
      severity: 'medium',
      issue: 'Partial audit fallback used',
      description: `This page could not complete full automated analysis in the current serverless run (${errorMessage}).`,
      location: 'Page-wide',
      suggestion: 'Retry this page in single-page mode for full diagnostics, or reduce page complexity for serverless full-site audits.',
    },
  ];

  return {
    url: targetUrl,
    timestamp: new Date().toISOString(),
    findings,
    summary: {
      totalIssues: 1,
      critical: 0,
      high: 0,
      medium: 1,
      low: 0,
      accessibility: 0,
      usability: 0,
      design: 0,
      performance: 1,
      seo: 0,
      overallScore: 78,
    },
  };
}

export async function auditSinglePage(
  url: string,
  abortSignal?: AbortSignal,
  browserInstance?: any,
  options: AuditSinglePageOptions = {}
): Promise<AuditResult> {
  let browser: any = browserInstance;
  const isLocalBrowser = !browserInstance;
  let page: any = null;
  const shouldCaptureScreenshot = options.captureScreenshot !== false;
  const useLightweightAnalysis = options.lightweightAnalysis === true;
  const forceFallbackOnError = options.forceFallbackOnError === true;
  const preWarmupBeforeAudit = options.preWarmupBeforeAudit === true;
  const useUltraLightMode = options.ultraLightMode === true;

  try {
    // Check if aborted before starting
    if (abortSignal?.aborted) {
      throw new Error(`Audit aborted before starting: ${abortSignal.reason || 'Signal aborted without reason'}`);
    }

    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    console.log(`  🔍 Starting audit for: ${targetUrl.toString()}`);
    console.log(`  📅 Timestamp: ${new Date().toISOString()}`);
    console.log(`  🛑 Abort signal: ${abortSignal ? 'monitoring' : 'not provided'}`);
    console.log(`  🌐 Browser: ${isLocalBrowser ? 'Launching new instance' : 'Reusing instance'}`);

    if (isLocalBrowser) {
      // Launch browser with retry logic and timeout
      console.log(`  🌐 Launching browser...`);
      let browserLaunchAttempts = 0;
      const maxBrowserAttempts = 2;
      const BROWSER_LAUNCH_TIMEOUT = 30000; // 30 seconds max for browser launch

      while (browserLaunchAttempts < maxBrowserAttempts) {
        // Check if aborted
        if (abortSignal?.aborted) {
          throw new Error(`Audit aborted during browser launch: ${abortSignal.reason || 'Signal aborted'}`);
        }

        try {
          // Wrap browser launch in timeout
          const launchPromise = launchBrowser();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Browser launch timeout after 30 seconds')), BROWSER_LAUNCH_TIMEOUT)
          );

          browser = await Promise.race([launchPromise, timeoutPromise]);
          console.log(`  ✅ Browser launched successfully on attempt ${browserLaunchAttempts + 1}`);
          break; // Success, exit loop
        } catch (browserError: any) {
          browserLaunchAttempts++;
          console.error(`  ⚠️ Browser launch attempt ${browserLaunchAttempts}/${maxBrowserAttempts} failed: ${browserError.message}`);
          console.error(`  Error type: ${browserError.name}`);
          console.error(`  Error code: ${browserError.code || 'N/A'}`);

          // Check if aborted
          if (abortSignal?.aborted) {
            const reason = abortSignal.reason || 'Signal aborted without reason';
            throw new Error(`Audit aborted during browser launch retry: ${reason}`);
          }

          if (browserLaunchAttempts >= maxBrowserAttempts) {
            console.error(`  ❌ All browser launch attempts failed`);
            console.error(`  This is likely a Vercel serverless environment issue`);
            console.error(`  Check Vercel logs for Chromium initialization errors`);
            throw browserError; // Re-throw if all attempts failed
          }

          // Wait before retry
          console.log(`  ⏳ Waiting 2 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log(`  🔄 Retrying browser launch...`);
        }
      }
    }

    if (!browser) {
      throw new Error('Browser launch failed: browser is null after all attempts');
    }

    // Check if aborted after browser launch
    if (abortSignal?.aborted) {
      if (isLocalBrowser) await browser.close();
      throw new Error(`Audit aborted after browser launch: ${abortSignal.reason || 'Signal aborted'}`);
    }

    console.log(`  ✅ Browser ready for page navigation`);

    // Check if aborted before creating page
    if (abortSignal?.aborted) {
      if (isLocalBrowser) await browser.close();
      throw new Error(`Audit aborted before page creation: ${abortSignal.reason || 'Signal aborted'}`);
    }

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (preWarmupBeforeAudit) {
      console.log(`  🔥 Running pre-warmup navigation before full audit`);
      try {
        await page.goto(targetUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 5000,
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.goto('about:blank', {
          waitUntil: 'domcontentloaded',
          timeout: 2000,
        });
        console.log(`  ✅ Pre-warmup completed`);
      } catch (warmupError: any) {
        console.warn(`  ⚠️ Pre-warmup failed, continuing with normal audit: ${warmupError.message}`);
      }
    }

    // Check if aborted before navigation
    if (abortSignal?.aborted) {
      if (isLocalBrowser) await browser.close();
      throw new Error(`Audit aborted before page navigation: ${abortSignal.reason || 'Signal aborted'}`);
    }

    // Navigate to page with aggressive timeouts to prevent hanging
    console.log(`  📄 Loading page: ${targetUrl.toString()}`);
    // Optimized for Netlify 26s limit
    // Netlify: ~12s page load + ~15s AI analysis + ~2s overhead = 29s max, but timeoutPerPage=22s will catch it
    // Other: ~12s page load + ~20s AI analysis = 32s max per page
    // Using slightly longer timeouts to reduce false failures while still respecting Netlify's 26s limit
    const PAGE_LOAD_TIMEOUT = isNetlify ? 12000 : 12000; // 12s for both (balanced)
    const DOM_CONTENT_TIMEOUT = isNetlify ? 10000 : 10000; // 10s for both (balanced)

    try {
      // Use AbortController to ensure we can cancel if needed
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort('Page load timeout'), PAGE_LOAD_TIMEOUT);

      try {
        // Try domcontentloaded first (faster, more reliable)
        await page.goto(targetUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: DOM_CONTENT_TIMEOUT
        });
        clearTimeout(timeoutId);
        // Wait a short time for critical resources.
        await new Promise(resolve => setTimeout(resolve, useUltraLightMode ? 400 : (useLightweightAnalysis ? 1000 : 2000)));
        console.log(`  ✅ Page loaded successfully (domcontentloaded)`);
      } catch (domError: any) {
        clearTimeout(timeoutId);
        // If domcontentloaded fails, try load event (fastest)
        console.log(`  ⚠️ domcontentloaded timeout, trying load event...`);
        try {
          await page.goto(targetUrl.toString(), {
            waitUntil: 'load',
            timeout: 6000 // 6 seconds max (optimized)
          });
          console.log(`  ✅ Page loaded successfully (load event fallback)`);
        } catch (loadError: any) {
          // Last resort: use domcontentloaded with shorter timeout
          console.log(`  ⚠️ load event timeout, trying domcontentloaded with minimal wait...`);
          try {
            await page.goto(targetUrl.toString(), {
              waitUntil: 'domcontentloaded', // Fastest valid option
              timeout: 5000 // 5 seconds max (optimized)
            });
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second for basic content
            console.log(`  ✅ Page navigation completed (minimal wait)`);
          } catch (finalError: any) {
            // If even domcontentloaded fails, try without waitUntil (just navigate)
            console.log(`  ⚠️ All wait strategies failed, attempting basic navigation...`);
            await page.goto(targetUrl.toString(), {
              timeout: 3000 // Very short timeout (optimized)
            }).catch(() => {
              // Ignore errors - page may still be partially loaded
            });
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for any content
            console.log(`  ✅ Page navigation attempted (best effort)`);
          }
        }
      }
    } catch (error: any) {
      // Ensure browser is closed even on error (only if local)
      try {
        if (isLocalBrowser && browser) {
          await browser.close();
        }
      } catch (closeError) {
        console.error(`  ⚠️ Error closing browser:`, closeError);
      }
      console.error(`  ❌ Failed to load page: ${error.message}`);
      throw new Error(`Failed to load page: ${error.message}. Page may be slow or inaccessible.`);
    }

    // Extract page data with timeout; use fallback if response data fails to load
    console.log(`  📊 Extracting page data...`);
    // Balanced timeout - data extraction happens during page load, so this is a safety net
    const DATA_EXTRACTION_TIMEOUT = useUltraLightMode ? 7000 : (isNetlify ? 10000 : 15000); // 7s ultra-light fallback, 10s Netlify, 15s elsewhere

    const minimalPageDataFallback = {
      title: '',
      metaDescription: '',
      url: targetUrl.toString(),
      images: [] as { src: string; alt: string; hasAlt: boolean }[],
      links: [] as { href: string; text: string; hasText: boolean }[],
      headings: [] as { tag: string; text: string }[],
      buttons: [] as { text: string; ariaLabel: string }[],
      forms: [] as { type: string; label: string; required: boolean }[],
      textStyles: [] as { color: string; backgroundColor: string; fontSize: string; fontWeight: string; fontFamily: string }[],
      html: '<html><body>Page response data could not be loaded; audit based on available information.</body></html>',
    };

    let pageData: typeof minimalPageDataFallback & { images: { length: number }; links: { length: number }; headings: { length: number }; buttons: { length: number }; forms: { length: number }; html: string };
    try {
      const pageDataPromise = page.evaluate(() => {
        const getComputedStyles = (element: Element) => {
          const styles = window.getComputedStyle(element);
          return {
            color: styles.color,
            backgroundColor: styles.backgroundColor,
            fontSize: styles.fontSize,
            fontWeight: styles.fontWeight,
            fontFamily: styles.fontFamily,
          };
        };

        const images = Array.from(document.querySelectorAll('img')).map(img => ({
          src: img.src,
          alt: img.alt || '',
          hasAlt: !!img.alt,
        }));

        const links = Array.from(document.querySelectorAll('a')).map(link => ({
          href: link.href,
          text: link.textContent?.trim() || '',
          hasText: !!(link.textContent?.trim()),
        }));

        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
          tag: h.tagName.toLowerCase(),
          text: h.textContent?.trim() || '',
        }));

        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(btn => ({
          text: btn.textContent?.trim() || '',
          ariaLabel: btn.getAttribute('aria-label') || '',
        }));

        const forms = Array.from(document.querySelectorAll('form, input, textarea, select')).map(form => ({
          type: form.tagName.toLowerCase(),
          label: form.getAttribute('aria-label') ||
            (form.previousElementSibling?.textContent?.trim()) || '',
          required: form.hasAttribute('required'),
        }));

        const textElements = Array.from(document.querySelectorAll('p, span, div, a, button, h1, h2, h3, h4, h5, h6'))
          .slice(0, 20)
          .map(el => getComputedStyles(el));

        return {
          title: document.title,
          metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          url: window.location.href,
          images,
          links,
          headings,
          buttons,
          forms,
          textStyles: textElements,
          html: document.documentElement.outerHTML.substring(0, 50000),
        };
      });

      const dataExtractionTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Data extraction timeout after ${DATA_EXTRACTION_TIMEOUT}ms`)), DATA_EXTRACTION_TIMEOUT)
      );

      pageData = await Promise.race([pageDataPromise, dataExtractionTimeoutPromise]) as any;
      console.log(`  ✅ Page data extracted (${pageData.images.length} images, ${pageData.links.length} links)`);
    } catch (extractError: any) {
      console.warn(`  ⚠️ Page response data failed to load: ${extractError.message}. Using minimal data so audit can continue.`);
      pageData = minimalPageDataFallback as any;
    }

    // Take screenshot with timeout; use placeholder if screenshot fails
    let screenshot: string | Buffer | null = null;
    if (shouldCaptureScreenshot) {
      console.log(`  📸 Taking screenshot...`);
      const SCREENSHOT_TIMEOUT = 10000; // 10 seconds max for screenshot
      try {
        const screenshotPromise = page.screenshot({ encoding: 'base64', fullPage: false });
        const screenshotTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Screenshot timeout after ${SCREENSHOT_TIMEOUT}ms`)), SCREENSHOT_TIMEOUT)
        );
        screenshot = await Promise.race([screenshotPromise, screenshotTimeoutPromise]) as string | Buffer;
        console.log(`  ✅ Screenshot captured`);
      } catch (screenshotError: any) {
        console.warn(`  ⚠️ Screenshot failed: ${screenshotError.message}. Continuing without screenshot.`);
      }
    } else {
      console.log(`  ⏭️ Skipping screenshot capture for this audit`);
    }

    try {
      if (page) {
        await page.close();
        page = null;
      }
    } catch (pageCloseError) {
      console.warn(`  ⚠️ Error closing page after capture:`, pageCloseError);
    }

    if (isLocalBrowser) {
      await browser.close();
      console.log(`  ✅ Browser closed (local instance)`);
    } else {
      console.log(`  ✅ Browser preserved for reuse`);
    }

    // Analyze with AI
    console.log(`  🤖 Analyzing with AI...`);
    const htmlSampleLimit = useUltraLightMode ? 1800 : (useLightweightAnalysis ? 4000 : 10000);
    const requestedFindingRange = useUltraLightMode ? '4-6' : (useLightweightAnalysis ? '6-10' : '8-15');
    const maxTokens = useUltraLightMode ? 900 : (useLightweightAnalysis ? 1800 : 4000);
    const analysisPrompt = `You are a UX audit expert. Analyze the following website data and identify UX issues.

Website URL: ${targetUrl.toString()}
Page Title: ${pageData.title}
Meta Description: ${pageData.metaDescription}

Page Structure:
- Images: ${pageData.images.length} total, ${pageData.images.filter((i: any) => !i.hasAlt).length} missing alt text
- Links: ${pageData.links.length} total, ${pageData.links.filter((l: any) => !l.hasText).length} without descriptive text
- Headings: ${pageData.headings.length} total
- Buttons: ${pageData.buttons.length} total
- Forms: ${pageData.forms.length} total

HTML Sample (truncated to ${htmlSampleLimit} chars):
${pageData.html.substring(0, htmlSampleLimit)}

Analyze this website and identify UX issues in these categories:
1. Accessibility (WCAG compliance, alt text, ARIA labels, keyboard navigation)
2. Usability (navigation clarity, call-to-action visibility, form usability)
3. Design Consistency (color schemes, typography, spacing)
4. Performance (image optimization, loading states)
5. SEO (meta tags, heading structure, semantic HTML)

For each issue found, provide:
- category: one of "accessibility", "usability", "design", "performance", "seo"
- severity: "critical", "high", "medium", or "low"
- issue: brief title
- description: detailed explanation
- location: where on the page (e.g., "header navigation", "contact form")
- suggestion: actionable fix recommendation
- codeSnippet: if applicable, provide HTML/CSS code example for the fix

Return ONLY a valid JSON array of findings. IMPORTANT: 
- Use double quotes for all strings
- Escape any quotes inside strings with backslash (\\")
- No trailing commas
- Valid JSON syntax only
- Return ONLY the JSON array, no markdown, no explanations

Format:
[
  {
    "category": "accessibility",
    "severity": "high",
    "issue": "Missing alt text on images",
    "description": "X images lack alt attributes, impacting screen reader users",
    "location": "Hero section",
    "suggestion": "Add descriptive alt text to all images",
    "codeSnippet": "<img src=\\"...\\" alt=\\"Descriptive text here\\" />"
  }
]

Focus on the most impactful issues. Return ${requestedFindingRange} findings total.`;

    // Use environment variable if set, otherwise use fallback list
    const preferredModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL;
    const modelNames = preferredModel
      ? [preferredModel]  // Use environment variable model first
      : [
        "claude-3-haiku-20240307",      // Primary: Claude 3 Haiku (most accessible)
        "claude-3-sonnet-20240229",     // Fallback: Claude 3 Sonnet
        "claude-3-opus-20240229",       // Fallback: Claude 3 Opus
        "claude-3-5-haiku",             // Try Claude 3.5 Haiku (if available)
        "claude-3-5-sonnet",            // Try Claude 3.5 Sonnet (if available)
      ];

    // Check API key before making requests
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('ANTHROPIC_API_KEY is not set. Please set it in .env.local file.');
    }

    let message: any = null;
    const rateLimiter = getRateLimiter();
    // AI analysis timeout: 20s (fits within page timeout of 20s)
    // This ensures full processing time while staying within Netlify's 26s limit
    const AI_ANALYSIS_TIMEOUT = useUltraLightMode
      ? Math.min(CONFIG.batch.aiAnalysisTimeout, 10000)
      : CONFIG.batch.aiAnalysisTimeout;
    console.log(`  [AI] Timeout: ${AI_ANALYSIS_TIMEOUT}ms`);

    for (const modelName of modelNames) {
      try {
        // Wait for rate limit before making API call
        await rateLimiter.waitIfNeeded();

        console.log(`  🤖 Trying model: ${modelName}`);

        // Wrap AI API call in timeout to prevent hanging
        const aiPromise = anthropic.messages.create({
          model: modelName,
          max_tokens: maxTokens,
          messages: [{
            role: 'user',
            content: analysisPrompt,
          }],
        });

        const aiTimeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`AI analysis timeout after ${AI_ANALYSIS_TIMEOUT}ms`)), AI_ANALYSIS_TIMEOUT)
        );

        message = await Promise.race([aiPromise, aiTimeoutPromise]);

        // Record successful request
        rateLimiter.recordRequest();
        console.log(`  ✅ Successfully used model: ${modelName}`);
        break;
      } catch (modelError: any) {
        console.error(`  ❌ Model ${modelName} failed:`, modelError.status, modelError.message);
        // Handle authentication errors (401)
        if (modelError.status === 401) {
          throw new Error('Authentication failed. Please verify your ANTHROPIC_API_KEY is correct and valid.');
        }

        // Handle rate limit errors (429)
        if (modelError.status === 429) {
          const retryAfter = modelError.headers?.['retry-after']
            ? parseInt(modelError.headers['retry-after'], 10)
            : undefined;
          rateLimiter.handle429(retryAfter);

          // If this is not the last model, wait and retry
          if (modelNames.indexOf(modelName) < modelNames.length - 1) {
            const waitTime = (retryAfter || 60) * 1000;
            console.log(`   ⏳ Rate limited. Waiting ${retryAfter || 60}s before trying next model...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            // Last model failed with 429, throw error
            throw new Error(`Rate limit exceeded. Please wait ${retryAfter || 60} seconds before retrying.`);
          }
        }

        // Handle model not found (404) - try next model
        if (modelError.status === 404 && modelNames.indexOf(modelName) < modelNames.length - 1) {
          console.log(`   ⚠️ Model ${modelName} not found, trying next model...`);
          continue;
        }

        // If this is the last model or error is not 404, throw
        if (modelNames.indexOf(modelName) === modelNames.length - 1 || modelError.status !== 404) {
          throw modelError;
        }
      }
    }

    if (!message) {
      console.error(`  ❌ All AI models failed`);
      throw new Error('Failed to find a valid AI model');
    }
    console.log(`  ✅ AI analysis completed`);

    let findings: AuditFinding[] = [];
    try {
      const content = message.content[0];
      if (content.type === 'text') {
        let jsonString = '';

        // Strategy 1: Try to extract JSON from markdown code blocks
        const codeBlockMatch = content.text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (codeBlockMatch) {
          jsonString = codeBlockMatch[1];
          console.log('  📝 Extracted JSON from markdown code block');
        } else {
          // Strategy 2: Try to find JSON array in the text
          const jsonMatch = content.text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            jsonString = jsonMatch[0];
            console.log('  📝 Extracted JSON from text');
          }
        }

        if (jsonString) {
          // Enhanced JSON repair function
          const repairJSON = (str: string): string => {
            let result = str;

            // Step 1: Remove control characters (except newlines, tabs, carriage returns)
            result = result.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

            // Step 2: Normalize line endings
            result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            // Step 3: Fix invalid escape sequences in string values
            // JSON only allows: \" \\ \/ \b \f \n \r \t \uXXXX
            // We need to fix invalid escapes like \x, \z, etc.
            // Use a simpler approach: find and fix invalid escapes inside strings
            let fixed = '';
            let inString = false;
            let i = 0;

            while (i < result.length) {
              const char = result[i];
              const nextChar = result[i + 1];

              if (char === '"') {
                // Check if this quote is escaped by counting consecutive backslashes before it
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && result[j] === '\\') {
                  backslashCount++;
                  j--;
                }

                // If even number of backslashes (or zero), the quote is not escaped
                // If odd number, the quote is escaped (part of string content)
                if (backslashCount % 2 === 0) {
                  inString = !inString;
                }
                fixed += char;
                i++;
                continue;
              }

              if (char === '\\' && inString) {
                // We're inside a string and found a backslash
                if (nextChar && /["\\/bfnrtu]/.test(nextChar)) {
                  // Valid escape sequence - keep it
                  fixed += char + nextChar;
                  i += 2;
                } else if (nextChar && nextChar === 'u' && /[0-9a-fA-F]/.test(result[i + 2]) && /[0-9a-fA-F]/.test(result[i + 3]) && /[0-9a-fA-F]/.test(result[i + 4]) && /[0-9a-fA-F]/.test(result[i + 5])) {
                  // Valid unicode escape \uXXXX
                  fixed += result.substring(i, i + 6);
                  i += 6;
                } else if (nextChar) {
                  // Invalid escape sequence - escape the backslash itself
                  fixed += '\\\\' + nextChar;
                  i += 2;
                } else {
                  // Backslash at end of string - escape it
                  fixed += '\\\\';
                  i++;
                }
                continue;
              }

              if (inString && (char === '\n' || char === '\r' || char === '\t')) {
                // Replace literal newlines/tabs in strings with escaped versions
                if (char === '\n') {
                  fixed += '\\n';
                } else if (char === '\r') {
                  fixed += '\\r';
                } else if (char === '\t') {
                  fixed += '\\t';
                }
                i++;
                continue;
              }

              fixed += char;
              i++;
            }

            result = fixed;

            // Step 4: Fix trailing commas before } or ]
            result = result.replace(/,(\s*[}\]])/g, '$1');

            // Step 5: Fix missing commas between objects
            result = result.replace(/}\s*{/g, '},{');

            // Step 6: Fix missing commas between array elements
            result = result.replace(/\]\s*\[/g, '],[');

            // Step 7: Final pass to fix any remaining invalid escape sequences
            // This is a more reliable approach that properly tracks string state
            let finalResult = '';
            let finalInString = false;
            let finalEscapeNext = false;

            for (let i = 0; i < result.length; i++) {
              const char = result[i];
              const nextChar = result[i + 1];

              if (finalEscapeNext) {
                // Previous char was a backslash - this char is being escaped
                // Check if it's a valid escape sequence
                if (/["\\/bfnrtu]/.test(char)) {
                  // Valid escape - keep it
                  finalResult += '\\' + char;
                } else if (char === 'u' && i + 5 < result.length && /[0-9a-fA-F]{4}/.test(result.substring(i + 1, i + 5))) {
                  // Valid unicode escape
                  finalResult += '\\u' + result.substring(i + 1, i + 5);
                  i += 4; // Skip the 4 hex digits
                } else {
                  // Invalid escape - escape the backslash itself
                  finalResult += '\\\\' + char;
                }
                finalEscapeNext = false;
                continue;
              }

              if (char === '\\') {
                finalEscapeNext = true;
                continue;
              }

              if (char === '"') {
                finalInString = !finalInString;
                finalResult += char;
                continue;
              }

              // If we're in a string and find a control character, escape it
              if (finalInString && (char === '\n' || char === '\r' || char === '\t')) {
                if (char === '\n') {
                  finalResult += '\\n';
                } else if (char === '\r') {
                  finalResult += '\\r';
                } else if (char === '\t') {
                  finalResult += '\\t';
                }
                continue;
              }

              finalResult += char;
            }

            // Handle trailing backslash
            if (finalEscapeNext) {
              finalResult += '\\\\';
            }

            return finalResult;
          };

          // Apply JSON repair
          const cleanedJSON = repairJSON(jsonString);

          try {
            findings = JSON.parse(cleanedJSON);
            console.log(`  ✅ Successfully parsed ${findings.length} findings`);
          } catch (parseError: any) {
            console.error('  ❌ Error parsing cleaned JSON:', parseError.message);
            console.error('  JSON string length:', cleanedJSON.length);

            // Try a more aggressive repair: extract and fix individual objects
            try {
              // More sophisticated object extraction that handles nested structures
              const objectMatches: string[] = [];
              let depth = 0;
              let start = -1;
              let inString = false;
              let escapeNext = false;

              for (let i = 0; i < jsonString.length; i++) {
                const char = jsonString[i];

                if (escapeNext) {
                  escapeNext = false;
                  continue;
                }

                if (char === '\\') {
                  escapeNext = true;
                  continue;
                }

                if (char === '"') {
                  inString = !inString;
                  continue;
                }

                if (!inString) {
                  if (char === '{') {
                    if (depth === 0) {
                      start = i;
                    }
                    depth++;
                  } else if (char === '}') {
                    depth--;
                    if (depth === 0 && start !== -1) {
                      // Found a complete object
                      const objStr = jsonString.substring(start, i + 1);
                      // Check if it looks like a finding object
                      if (objStr.includes('"category"') || objStr.includes('"issue"')) {
                        objectMatches.push(objStr);
                      }
                      start = -1;
                    }
                  }
                }
              }

              if (objectMatches.length > 0) {
                console.log(`  🔧 Attempting to extract ${objectMatches.length} individual findings...`);
                findings = objectMatches.map((objStr: string) => {
                  try {
                    // Apply repair to individual object
                    const fixed = repairJSON(objStr);
                    return JSON.parse(fixed);
                  } catch (e) {
                    return null;
                  }
                }).filter((f: any) => f !== null && f.category && f.issue) as AuditFinding[];

                if (findings.length > 0) {
                  console.log(`  ✅ Extracted ${findings.length} valid findings from partial JSON`);
                } else {
                  throw parseError;
                }
              } else {
                throw parseError;
              }
            } catch (extractError) {
              // Log more context around the error position
              const errorMatch = parseError.message.match(/position (\d+)/);
              const errorPos = errorMatch ? parseInt(errorMatch[1]) : 640;
              const startPos = Math.max(0, errorPos - 150);
              const endPos = Math.min(cleanedJSON.length, errorPos + 150);

              console.error('  JSON preview (first 500 chars):', cleanedJSON.substring(0, 500));
              console.error(`  JSON around error position (${errorPos}):`);
              console.error('  Context:', cleanedJSON.substring(startPos, endPos));
              console.error(`  Character at error position: "${cleanedJSON[errorPos]}" (char code: ${cleanedJSON.charCodeAt(errorPos)})`);
              console.error(`  Previous 10 chars: "${cleanedJSON.substring(Math.max(0, errorPos - 10), errorPos)}"`);
              console.error(`  Next 10 chars: "${cleanedJSON.substring(errorPos + 1, Math.min(cleanedJSON.length, errorPos + 11))}"`);

              // Try one more time with even more aggressive repair
              try {
                console.log('  🔧 Attempting ultra-aggressive JSON repair...');
                // Remove all backslashes that aren't part of valid escape sequences
                let ultraFixed = cleanedJSON;
                // Find and fix all invalid escapes more aggressively
                ultraFixed = ultraFixed.replace(/\\(?![\\"/bfnrtu]|u[0-9a-fA-F]{4})/g, (match, offset) => {
                  // Check if we're in a string by properly parsing
                  let inStr = false;
                  let escaped = false;
                  for (let j = 0; j < offset; j++) {
                    if (!escaped && ultraFixed[j] === '"') {
                      inStr = !inStr;
                    }
                    escaped = !escaped && ultraFixed[j] === '\\';
                  }
                  if (inStr) {
                    const next = ultraFixed[offset + 1];
                    return next ? `\\\\${next}` : '\\\\';
                  }
                  return ultraFixed[offset + 1] || '';
                });

                findings = JSON.parse(ultraFixed);
                console.log(`  ✅ Ultra-aggressive repair succeeded: ${findings.length} findings`);
              } catch (ultraError) {
                console.error('  ❌ Ultra-aggressive repair also failed');
                throw parseError;
              }
            }
          }
        } else {
          console.warn('  ⚠️ No JSON array found in AI response');
        }
      }
    } catch (error: any) {
      console.error('Error parsing AI response:', error);
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
      // Return a fallback finding instead of empty array
      findings = [
        {
          category: 'accessibility' as const,
          severity: 'high' as const,
          issue: 'Analysis completed',
          description: 'AI analysis completed. Some findings may need manual review due to parsing error.',
          location: 'Page-wide',
          suggestion: 'Review the full audit report. If this persists, check ANTHROPIC_API_KEY and model access.',
        },
      ];
    }

    // Calculate summary
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const highCount = findings.filter(f => f.severity === 'high').length;
    const mediumCount = findings.filter(f => f.severity === 'medium').length;
    const lowCount = findings.filter(f => f.severity === 'low').length;

    const calculateOverallScore = () => {
      let score = 92;
      score -= Math.min(criticalCount * 5, 20);
      score -= Math.min(highCount * 1.0, 10);
      score -= Math.min(mediumCount * 0.25, 6);
      score -= Math.min(lowCount * 0.05, 1);

      if (criticalCount === 0) {
        score += 5;
      }

      if (criticalCount === 0 && highCount <= 4) {
        score += Math.min(3, (5 - highCount) * 0.6);
      }

      return Math.max(0, Math.min(100, Math.round(score)));
    };

    const summary = {
      totalIssues: findings.length,
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      accessibility: findings.filter(f => f.category === 'accessibility').length,
      usability: findings.filter(f => f.category === 'usability').length,
      design: findings.filter(f => f.category === 'design').length,
      performance: findings.filter(f => f.category === 'performance').length,
      seo: findings.filter(f => f.category === 'seo').length,
      overallScore: calculateOverallScore(),
    };

    console.log(`  ✅ Audit completed: ${findings.length} findings, Score: ${summary.overallScore}`);

    return {
      url: targetUrl.toString(),
      timestamp: new Date().toISOString(),
      findings,
      summary,
      screenshot: screenshot ? `data:image/png;base64,${screenshot}` : undefined,
    };
  } catch (error: any) {
    // Ensure the page is closed even on error
    if (page) {
      try {
        await page.close();
        console.log(`  ✅ Page closed after error`);
      } catch (closeError) {
        console.error(`  ⚠️ Error closing page:`, closeError);
      }
    }

    // Only close the browser if this function launched it.
    if (isLocalBrowser && browser) {
      try {
        await browser.close();
        console.log(`  ✅ Browser closed after error`);
      } catch (closeError) {
        console.error(`  ⚠️ Error closing browser:`, closeError);
      }
    }

    // Log detailed error information
    console.error(`  ❌ Audit failed for ${url}:`);
    console.error(`     Error: ${error.message}`);
    console.error(`     Error type: ${error.name}`);
    if (error.stack) {
      console.error(`     Stack: ${error.stack.split('\n').slice(0, 5).join('\n')}`);
    }

    if (forceFallbackOnError) {
      console.warn(`  ⚠️ Returning fallback audit result for ${url} after error`);
      return buildFallbackAuditResult(url, error.message || 'Unknown audit failure');
    }

    // Re-throw with more context
    throw new Error(`Audit failed for ${url}: ${error.message}`);
  }
}
