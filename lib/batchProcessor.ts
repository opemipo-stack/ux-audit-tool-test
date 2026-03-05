/**
 * Batch Processor
 * Processes pages in batches to avoid timeouts and rate limits
 */

import { AuditResult } from '../types/audit';
import { auditSinglePage, AuditSinglePageOptions } from './auditHelper';
import { updatePageProgress, updateStatus } from './progressTracker';
import { CONFIG } from './config';

export interface FailedPage {
  url: string;
  error: string;
  errorType: 'timeout' | 'network' | 'rate_limit' | 'browser' | 'api' | 'unknown';
  retryable: boolean;
}

export interface BatchConfig {
  batchSize: number;
  delayBetweenBatches: number;
  delayBetweenRequests: number;
  maxRetries: number;
  timeoutPerPage: number;
  forceFallbackOnError?: boolean;
  firstPageHardening?: boolean;
  firstPageUrl?: string;
}

// Configuration for one-page-at-a-time processing
// Matches Netlify's 26s timeout limit while keeping original processing times
const DEFAULT_CONFIG: BatchConfig = {
  batchSize: 1, // Process one page at a time (not in batches)
  delayBetweenBatches: 0, // No delay needed for single-page processing
  delayBetweenRequests: CONFIG.batch.delayBetweenRequests, // 500ms delay (original)
  maxRetries: CONFIG.batch.maxRetries, // Single retry
  timeoutPerPage: CONFIG.batch.timeoutPerPage, // 20s per page (original, fits in Netlify 26s limit)
  forceFallbackOnError: false,
  firstPageHardening: false,
};

/**
 * Delays execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Splits array into chunks of specified size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Categorizes an error and determines if it's retryable
 */
function categorizeError(error: any): { type: FailedPage['errorType'], retryable: boolean, message: string } {
  const errorMessage = error?.message?.toLowerCase() || '';
  const errorStatus = error?.status;

  // Rate limit errors
  if (errorStatus === 429 || errorMessage.includes('rate limit')) {
    return {
      type: 'rate_limit',
      retryable: true,
      message: 'Rate limit exceeded. Please wait before retrying.',
    };
  }

  // Timeout errors
  if (errorMessage.includes('timeout') || errorMessage.includes('took longer than')) {
    return {
      type: 'timeout',
      retryable: true,
      message: 'Page load timeout. The page took too long to load.',
    };
  }

  // Network errors
  if (
    errorMessage.includes('network') ||
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('enotfound') ||
    errorMessage.includes('dns') ||
    errorStatus === 503 ||
    errorStatus === 502 ||
    errorStatus === 504
  ) {
    return {
      type: 'network',
      retryable: true,
      message: 'Network error. Unable to reach the website.',
    };
  }

  // Browser errors
  if (
    errorMessage.includes('browser') ||
    errorMessage.includes('chromium') ||
    errorMessage.includes('puppeteer') ||
    errorMessage.includes('executable')
  ) {
    return {
      type: 'browser',
      retryable: false,
      message: 'Browser launch failed. This may be a server configuration issue.',
    };
  }

  // API errors
  if (errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429) {
    return {
      type: 'api',
      retryable: errorStatus >= 500, // Retry on 5xx errors
      message: `API error (${errorStatus}). ${errorMessage || 'Request failed'}`,
    };
  }

  // Unknown errors
  return {
    type: 'unknown',
    retryable: true,
    message: error?.message || 'Unknown error occurred',
  };
}

/**
 * Audits a single page with retry logic and timeout
 */
async function auditSinglePageWithRetry(
  url: string,
  jobId: string,
  config: BatchConfig,
  abortSignal?: AbortSignal,
  browserInstance?: any,
  pageOptions?: AuditSinglePageOptions
): Promise<AuditResult> {
  console.log(`[auditSinglePageWithRetry] 🚀 Starting audit for ${url}`);
  console.log(`[auditSinglePageWithRetry] Job ID: ${jobId}`);
  console.log(`[auditSinglePageWithRetry] Max retries: ${config.maxRetries}`);
  console.log(`[auditSinglePageWithRetry] Timeout: ${config.timeoutPerPage}ms`);
  console.log(`[auditSinglePageWithRetry] Abort signal: ${abortSignal ? 'provided' : 'not provided'}`);

  // Create internal abort controller if not provided
  const internalAbortController = abortSignal ? null : new AbortController();
  const signal = abortSignal || internalAbortController!.signal;

  // Set timeout to abort if takes too long
  let abortTimeout: NodeJS.Timeout | null = null;
  if (!abortSignal && internalAbortController) {
    abortTimeout = setTimeout(() => {
      console.error(`[auditSinglePageWithRetry] ⚠️ Aborting audit for ${url} - exceeded timeout`);
      internalAbortController.abort('Audit timeout exceeded');
    }, config.timeoutPerPage + 5000); // 5 seconds buffer
  }

  let lastError: Error | null = null;
  let lastErrorCategory: { type: FailedPage['errorType'], retryable: boolean, message: string } | null = null;

  try {
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      // Check if aborted
      if (signal.aborted) {
        const reason = signal.reason || 'Signal aborted without reason';
        throw new Error(`Audit aborted due to timeout or cancellation: ${reason}`);
      }

      console.log(`[auditSinglePageWithRetry] Attempt ${attempt}/${config.maxRetries} for ${url}`);

      try {
        // Note: Status is already set to 'processing' in processBatches before calling this function
        // Only update status message here
        await updateStatus(jobId, 'auditing', url);
        console.log(`[auditSinglePageWithRetry] ✅ Status updated`);

        // Create timeout promise
        const timeoutPromise = new Promise<AuditResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: Page took longer than ${config.timeoutPerPage}ms`)), config.timeoutPerPage)
        );

        console.log(`[auditSinglePageWithRetry] Calling auditSinglePage...`);
        const auditStartTime = Date.now();

        // Race between audit and timeout
        const result = await Promise.race([
          auditSinglePage(url, signal, browserInstance, pageOptions),
          timeoutPromise
        ]);

        if (abortTimeout) clearTimeout(abortTimeout);

        const auditDuration = Date.now() - auditStartTime;
        console.log(`[auditSinglePageWithRetry] ✅ Audit completed in ${auditDuration}ms`);
        
        // Log warning if page took too long (close to timeout)
        if (auditDuration > config.timeoutPerPage * 0.8) {
          console.warn(`[auditSinglePageWithRetry] ⚠️ Page took ${auditDuration}ms (${Math.round(auditDuration/config.timeoutPerPage*100)}% of timeout limit)`);
        }

        return result;
      } catch (error: any) {
        lastError = error;
        lastErrorCategory = categorizeError(error);

        console.error(`❌ Attempt ${attempt}/${config.maxRetries} failed for ${url}`);
        console.error(`   Error Type: ${lastErrorCategory.type}`);
        console.error(`   Retryable: ${lastErrorCategory.retryable}`);
        console.error(`   Message: ${lastErrorCategory.message}`);
        console.error(`   Original Error: ${error.message}`);

        // Don't retry if error is not retryable
        if (!lastErrorCategory.retryable && attempt < config.maxRetries) {
          console.log(`   ⚠️ Error is not retryable, skipping remaining attempts`);
          break;
        }

        if (attempt < config.maxRetries) {
          // Exponential backoff: base delay increases exponentially
          // Netlify: 500ms, 1000ms | Others: 1000ms, 2000ms, 4000ms
          const baseDelay = CONFIG.batch.delayBetweenRequests * 2; // Start with 2x request delay
          const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), CONFIG.redis.retryDelay.max);
          console.log(`   ⏳ Retrying ${url} in ${backoffDelay}ms (attempt ${attempt}/${config.maxRetries})...`);
          await delay(backoffDelay);
        } else {
          // Mark as failed after all retries
          try {
            await updatePageProgress(jobId, url, 'failed');
            console.error(`   ❌ All retries exhausted for ${url} - marked as failed`);
          } catch (updateError: any) {
            console.error(`   ❌ CRITICAL: Failed to mark ${url} as failed:`, updateError.message);
            // Try one more time
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              await updatePageProgress(jobId, url, 'failed');
              console.log(`   ✅ Retry: Marked ${url} as failed`);
            } catch (retryError) {
              console.error(`   ❌ CRITICAL: Retry also failed to mark ${url} as failed`);
            }
          }
        }
      }
    }
  } finally {
    if (abortTimeout) clearTimeout(abortTimeout);
    
    // CRITICAL: Final safety check - if we're exiting with an error and page is still "processing", mark as failed
    // Enhanced with retry logic to ensure status is updated
    if (lastError) {
      let finalStatusUpdated = false;
      for (let finalRetry = 0; finalRetry < 3 && !finalStatusUpdated; finalRetry++) {
        try {
          const { getProgress } = await import('./progressTracker');
          const progress = await getProgress(jobId);
          if (progress) {
            const pageResult = progress.pageResults.find(p => p.url === url);
            if (pageResult && pageResult.status === 'processing') {
              console.error(`[auditSinglePageWithRetry] ⚠️ CRITICAL: Page ${url} still in 'processing' state after error - marking as failed (attempt ${finalRetry + 1}/3)`);
              await updatePageProgress(jobId, url, 'failed');
              finalStatusUpdated = true;
              console.log(`[auditSinglePageWithRetry] ✅ Successfully marked ${url} as failed in finally block`);
            } else if (pageResult && pageResult.status !== 'processing') {
              // Page status is already updated, no need to retry
              finalStatusUpdated = true;
              console.log(`[auditSinglePageWithRetry] ✅ Page ${url} status is already ${pageResult.status}, no update needed`);
            }
          }
        } catch (finalCheckError: any) {
          console.error(`[auditSinglePageWithRetry] ⚠️ Failed final status check (attempt ${finalRetry + 1}/3):`, finalCheckError.message);
          if (finalRetry < 2) {
            await delay(300 * (finalRetry + 1)); // Exponential backoff: 300ms, 600ms
          }
        }
      }
      if (!finalStatusUpdated) {
        console.error(`[auditSinglePageWithRetry] ⚠️ CRITICAL: Failed to update final status for ${url} after 3 attempts`);
      }
    }
  }

  // Throw error with categorized information
  const errorWithCategory = lastError || new Error('Max retries exceeded');
  (errorWithCategory as any).category = lastErrorCategory;
  throw errorWithCategory;
}

/**
 * Processes pages in batches with progress tracking
 */
export async function processBatches(
  pages: string[],
  jobId: string,
  config: BatchConfig = DEFAULT_CONFIG
): Promise<{ successful: AuditResult[], failed: FailedPage[] }> {
  console.log(`[processBatches] 🚀 Starting batch processing`);
  console.log(`[processBatches] Job ID: ${jobId}`);
  console.log(`[processBatches] Pages to process: ${pages.length}`);
  const platform = CONFIG.platform.isNetlify ? 'NETLIFY' : CONFIG.platform.isVercel ? 'VERCEL' : 'LOCAL';
  console.log(`[processBatches] Environment: ${platform} ${CONFIG.platform.isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log(`[processBatches] Config:`, JSON.stringify(config, null, 2));
  
  // Don't skip remaining pages - process every page (no circuit breaker)
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 999;

  const batches = chunkArray(pages, config.batchSize);
  const successful: AuditResult[] = [];
  const failed: FailedPage[] = [];

  console.log(`[processBatches] 📦 Processing ${pages.length} pages in ${batches.length} batches (${config.batchSize} pages per batch)`);

  // CRITICAL: Verify we can actually start processing
  // But don't throw error if verification fails - log and continue anyway
  console.log(`[processBatches] 🔍 Verifying batch processing can start...`);
  try {
    // Test that we can update status (verifies Redis connection)
    await updateStatus(jobId, 'auditing', 'Verifying batch processing startup...');
    console.log(`[processBatches] ✅ Status update verified - Redis connection OK`);
  } catch (verifyError: any) {
    console.error(`[processBatches] ⚠️ WARNING: Cannot update status - ${verifyError.message}`);
    console.error(`[processBatches] ⚠️ Will continue processing anyway - status updates may fail but pages will still be audited`);
    // Don't throw - continue processing even if status update fails
    // This ensures pages are still audited even if Redis/status tracking has issues
  }

  // Update status to show we're starting
  try {
    await updateStatus(jobId, 'auditing', 'Starting batch processing...');
    console.log(`[processBatches] ✅ Status updated to 'auditing'`);
  } catch (statusError: any) {
    console.error(`[processBatches] ⚠️ Failed to update status:`, statusError.message);
    // Continue anyway - status update failure shouldn't stop processing
  }

  const overallStartTime = Date.now();
  const pageOptions: AuditSinglePageOptions = {
    // Full-site batch audits on Netlify are time-constrained and do not persist screenshots anyway.
    captureScreenshot: !CONFIG.platform.isNetlify,
    lightweightAnalysis: CONFIG.platform.isNetlify,
    forceFallbackOnError: config.forceFallbackOnError === true,
  };

  // Add heartbeat to verify batch processing is running
  const heartbeatInterval = setInterval(() => {
    const elapsed = Date.now() - overallStartTime;
    console.log(`[processBatches] 💓 Heartbeat: Still processing... ${successful.length} completed, ${failed.length} failed (elapsed: ${(elapsed / 1000).toFixed(1)}s)`);
  }, 30000); // Every 30 seconds

  // Initialize browser for the entire batch to improve performance
  let browser: any = null;

  // Check if we're in production environment (using CONFIG for consistency)
  const isProduction = CONFIG.platform.isProduction;

  // Only use shared browser in production to prevent "too many chrome instances" errors
  // In dev, we can still use per-page or shared, but shared is faster
  const useSharedBrowser = true;

  if (useSharedBrowser) {
    try {
      console.log(`[processBatches] 🚀 Launching shared browser for batch processing...`);
      // Dynamically import to avoid circular dependencies if any
      const { launchBrowser } = await import('./auditHelper');
      browser = await launchBrowser();
      console.log(`[processBatches] ✅ Shared browser launched successfully`);
    } catch (error: any) {
      console.error(`[processBatches] ⚠️ Failed to launch shared browser: ${error.message}`);
      console.error(`[processBatches] Will fall back to per-page browser launch`);
    }
  }

  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchNumber = i + 1;

      const batchStartTime = Date.now();
      console.log(`\n[processBatches] 🔄 Processing batch ${batchNumber}/${batches.length} (${batch.length} pages)`);
      console.log(`[processBatches] Batch pages: ${batch.join(', ')}`);

      try {
        await updateStatus(jobId, 'auditing', `Batch ${batchNumber}/${batches.length}`);
      } catch (statusError: any) {
        console.error(`[processBatches] ⚠️ Failed to update status for batch ${batchNumber}:`, statusError.message);
      }

      // Process batch sequentially
      const batchResults = [];

      for (let index = 0; index < batch.length; index++) {
        const pageUrl = batch[index];

        // Only skip pages that are already completed or failed - never skip other pages
        // Include 'pending' and 'processing' (processing may be stuck from timeout)
        let shouldSkipPage = false;
        try {
          const { getProgress } = await import('./progressTracker');
          const currentProgress = await getProgress(jobId);
          if (currentProgress && Array.isArray(currentProgress.pageResults)) {
            const pageResult = currentProgress.pageResults.find(p => p && p.url === pageUrl);
            const pageStatus = pageResult?.status;
            
            if (!pageStatus) {
              console.warn(`[processBatches] ⚠️ Page ${pageUrl} not found in progress, will attempt audit`);
            } else if (pageStatus === 'completed') {
              console.log(`[processBatches] ⏭️ Skipping ${pageUrl} - already completed`);
              shouldSkipPage = true;
            } else if (pageStatus === 'failed') {
              console.log(`[processBatches] ⏭️ Skipping ${pageUrl} - already marked as failed`);
              shouldSkipPage = true;
            } else {
              // pending, processing, or any other status - do NOT skip, audit the page
              console.log(`[processBatches] ✅ Page ${pageUrl} is ${pageStatus}, proceeding with audit (no skip)`);
            }
          }
        } catch (statusCheckError: any) {
          console.error(`[processBatches] ⚠️ Failed to check page status for ${pageUrl}: ${statusCheckError.message}`);
          // Continue anyway - do not skip, allow audit to proceed
        }
        
        if (shouldSkipPage) {
          continue;
        }

        // Add delay between requests (except first)
        if (index > 0) {
          await delay(config.delayBetweenRequests);
        }

        console.log(`[processBatches] 🔍 Starting audit for page ${index + 1}/${batch.length}: ${pageUrl}`);
        const pageStartTime = Date.now();

        // CRITICAL: Set page status to 'processing' BEFORE starting audit
        // This ensures the UI shows the green loading indicator immediately
        // Add retry logic to ensure status is set even if first attempt fails
        let statusSet = false;
        for (let statusRetry = 0; statusRetry < 3 && !statusSet; statusRetry++) {
          try {
            await updatePageProgress(jobId, pageUrl, 'processing');
            console.log(`[processBatches] ✅ Set ${pageUrl} to 'processing' status (attempt ${statusRetry + 1})`);
            statusSet = true;
          } catch (statusUpdateError: any) {
            console.error(`[processBatches] ⚠️ Failed to set processing status for ${pageUrl} (attempt ${statusRetry + 1}/3): ${statusUpdateError.message}`);
            if (statusRetry < 2) {
              await delay(200 * (statusRetry + 1)); // Exponential backoff: 200ms, 400ms
            }
          }
        }
        if (!statusSet) {
          console.error(`[processBatches] ⚠️ CRITICAL: Failed to set processing status after 3 attempts - continuing anyway`);
        }

        // WATCHDOG Timer - Enhanced for stuck page detection
        let pageAuditCompleted = false;
        let watchdogTriggered = false;
        const watchdogTimer = setTimeout(() => {
          if (!pageAuditCompleted) {
            watchdogTriggered = true;
            console.error(`[processBatches] ⚠️ WATCHDOG: Page audit for ${pageUrl} is taking longer than expected (${config.timeoutPerPage}ms timeout)`);
            console.error(`[processBatches] ⚠️ WATCHDOG: This may indicate a stuck page - will attempt recovery`);
            
            // Attempt to mark as failed if watchdog triggers
            updatePageProgress(jobId, pageUrl, 'failed').catch((err: any) => {
              console.error(`[processBatches] ⚠️ WATCHDOG: Failed to mark page as failed: ${err.message}`);
            });
          }
        }, config.timeoutPerPage + 5000); // 5s buffer after timeout

        // Declare timeoutId outside try-catch so it's accessible in both
        let timeoutId: NodeJS.Timeout | null = null;
        let pageAbortController: AbortController | null = null;
        
        try {
          await updateStatus(jobId, 'auditing', `Auditing page ${index + 1}/${batch.length}: ${pageUrl}`);

          // CRITICAL: Create a NEW abort controller for EACH page
          // This ensures that aborting one page doesn't affect other pages
          pageAbortController = new AbortController();
          const abortSignal = pageAbortController.signal;

          // Pass the shared browser instance
          // We need to pass it to auditSinglePageWithRetry, which needs to pass it to auditSinglePage
          const shouldHardenFirstPage =
            config.firstPageHardening === true &&
            typeof config.firstPageUrl === 'string' &&
            config.firstPageUrl === pageUrl;

          const effectivePageOptions: AuditSinglePageOptions = shouldHardenFirstPage
            ? {
                ...pageOptions,
                captureScreenshot: false,
                lightweightAnalysis: true,
                preWarmupBeforeAudit: true,
                ultraLightMode: true,
              }
            : pageOptions;

          if (shouldHardenFirstPage) {
            console.log(`[processBatches] 🔧 First-page hardening enabled for ${pageUrl} (pre-warm + ultra-light profile)`);
          }

          const auditPromise = auditSinglePageWithRetry(pageUrl, jobId, config, abortSignal, browser, effectivePageOptions).catch((error: any) => {
            // CRITICAL: Catch errors early and ensure they have proper context
            if (error.message?.includes('aborted') || abortSignal.aborted) {
              const reason = abortSignal.reason || error.message || 'Signal aborted without reason';
              throw new Error(`Page audit cancelled for ${pageUrl}: ${reason}`);
            }
            throw error;
          });

          // Timeout handling - isolated per page
          const pageTimeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              console.error(`[processBatches] ⚠️ Page audit timeout - aborting ONLY this page: ${pageUrl}`);
              // Abort only this page's signal - does NOT affect other pages
              if (pageAbortController && !pageAbortController.signal.aborted) {
                pageAbortController.abort('Page audit timeout');
              }
              reject(new Error(`Page audit timeout: ${pageUrl} took longer than ${config.timeoutPerPage}ms`));
            }, config.timeoutPerPage);
          });

          const result = await Promise.race([
            auditPromise.then(r => {
              if (timeoutId) clearTimeout(timeoutId);
              // CRITICAL: Clear abort controller for this page to prevent any lingering effects
              return r;
            }).catch((error: any) => {
              // CRITICAL: Ensure abort signal error is caught and doesn't propagate
              if (timeoutId) clearTimeout(timeoutId);
              // Re-throw with clear message
              if (error.message?.includes('aborted') || (pageAbortController && pageAbortController.signal.aborted)) {
                const reason = pageAbortController?.signal.reason || error.message || 'Signal aborted without reason';
                throw new Error(`Page audit cancelled for ${pageUrl}: ${reason}`);
              }
              throw error;
            }),
            pageTimeoutPromise.catch((error: any) => {
              if (timeoutId) clearTimeout(timeoutId);
              throw error;
            })
          ]);

          pageAuditCompleted = true;
          clearTimeout(watchdogTimer);
          if (timeoutId) clearTimeout(timeoutId);

          const pageDuration = Date.now() - pageStartTime;
          console.log(`[processBatches] ✅ Completed audit for ${pageUrl} in ${pageDuration}ms`);
          
          // Reset circuit breaker on success
          consecutiveFailures = 0;
          
          batchResults.push({ status: 'fulfilled' as const, value: result, url: pageUrl });
          
          // CRITICAL: Immediately save result and update status for sequential processing
          // This ensures the page is fully completed before next page starts
          try {
            await updatePageProgress(jobId, pageUrl, 'completed', result.summary.overallScore);
            const { savePageResult } = await import('./progressTracker');
            await savePageResult(jobId, pageUrl, result);
            console.log(`[processBatches] ✅ Page ${pageUrl} fully completed and saved`);
          } catch (saveError: any) {
            console.error(`[processBatches] ⚠️ Failed to save page result for ${pageUrl}:`, saveError.message);
            // Try to at least update status
            try {
              await updatePageProgress(jobId, pageUrl, 'completed', result.summary.overallScore);
            } catch (statusError: any) {
              console.error(`[processBatches] ⚠️ Failed to update status:`, statusError.message);
            }
          }
        } catch (error: any) {
          pageAuditCompleted = true;
          clearTimeout(watchdogTimer);
          if (timeoutId) clearTimeout(timeoutId);

          const pageDuration = Date.now() - pageStartTime;
          console.error(`[processBatches] ❌ Failed audit for ${pageUrl} after ${pageDuration}ms`);
          console.error(`[processBatches] Error: ${error.message}`);
          console.error(`[processBatches] Error stack:`, error.stack);
          
          // CRITICAL: Check if this is an abort signal error
          const isAbortError = error.message?.includes('aborted') || 
                              error.message?.includes('cancelled') ||
                              error.message?.includes('timeout');
          
          if (isAbortError) {
            console.warn(`[processBatches] ⚠️ Page ${pageUrl} was aborted/cancelled - this is isolated to this page only`);
            console.warn(`[processBatches] ⚠️ Other pages will continue processing normally`);
          }
          
          // Circuit breaker: Track consecutive failures
          // CRITICAL: Only trigger circuit breaker for non-abort errors
          // Abort errors are expected (timeouts) and shouldn't trigger circuit breaker
          if (!isAbortError) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.error(`[processBatches] ⚠️ CIRCUIT BREAKER: ${consecutiveFailures} consecutive failures detected`);
              console.error(`[processBatches] ⚠️ Skipping remaining pages in this batch to prevent cascading failures`);
              // Reset counter after logging
              consecutiveFailures = 0;
            }
          } else {
            // Reset counter for abort errors (timeouts are expected)
            consecutiveFailures = 0;
          }
          
          // CRITICAL: Ensure page is marked as failed even if update fails
          try {
            await updatePageProgress(jobId, pageUrl, 'failed');
            console.log(`[processBatches] ✅ Marked ${pageUrl} as failed (isolated error - other pages continue)`);
          } catch (updateError: any) {
            console.error(`[processBatches] ❌ CRITICAL: Failed to mark ${pageUrl} as failed:`, updateError.message);
            // Try one more time after a short delay
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              await updatePageProgress(jobId, pageUrl, 'failed');
              console.log(`[processBatches] ✅ Retry: Marked ${pageUrl} as failed`);
            } catch (retryError: any) {
              console.error(`[processBatches] ❌ CRITICAL: Retry also failed to mark ${pageUrl} as failed`);
              // Even if status update fails, we continue to next page
              console.log(`[processBatches] ⚠️ Continuing to next page despite status update failure`);
            }
          }
          
          // CRITICAL: Log that we're continuing to next page
          console.log(`[processBatches] 🔄 Page ${pageUrl} error handled, continuing to next page in batch...`);

          // If browser crashed or disconnected, try to relaunch for next items
          // Enhanced browser recovery with retry logic
          const browserErrorPatterns = ['Session closed', 'Target closed', 'Protocol error', 'Browser closed', 'Connection closed'];
          const isBrowserError = browserErrorPatterns.some(pattern => 
            error.message.includes(pattern) || error.stack?.includes(pattern)
          );
          
          if (browser && isBrowserError) {
            console.warn(`[processBatches] ⚠️ Shared browser issue detected: ${error.message}`);
            console.warn(`[processBatches] 🔄 Attempting browser recovery...`);
            
            let browserRecovered = false;
            for (let recoveryAttempt = 0; recoveryAttempt < 2 && !browserRecovered; recoveryAttempt++) {
              try {
                // Close old browser instance
                try { 
                  await browser.close(); 
                  console.log(`[processBatches] ✅ Closed crashed browser instance`);
                } catch (closeError: any) {
                  console.warn(`[processBatches] ⚠️ Error closing crashed browser: ${closeError.message}`);
                }
                
                // Wait a bit before relaunching
                await delay(500 * (recoveryAttempt + 1));
                
                // Relaunch browser
                const { launchBrowser } = await import('./auditHelper');
                browser = await launchBrowser();
                console.log(`[processBatches] ✅ Shared browser relaunched successfully (attempt ${recoveryAttempt + 1})`);
                browserRecovered = true;
              } catch (relaunchError: any) {
                console.error(`[processBatches] ❌ Failed to relaunch browser (attempt ${recoveryAttempt + 1}/2):`, relaunchError.message);
                if (recoveryAttempt === 1) {
                  console.error(`[processBatches] ⚠️ Browser recovery failed - will fall back to per-page browser launch`);
                  browser = null; // Fallback to per-page
                }
              }
            }
          }

          batchResults.push({ status: 'rejected' as const, reason: error, url: pageUrl });
          
          // CRITICAL: Ensure we continue to next page even after error
          // The loop will continue automatically, but we log this for clarity
          console.log(`[processBatches] ✅ Error handled for ${pageUrl}, continuing to next page...`);
          
          // CRITICAL: Ensure abort controller is cleared to prevent any lingering effects
          // This prevents the abort signal from affecting subsequent pages
          try {
            if (pageAbortController) {
              // Abort controller is already scoped to this page only
              // Just ensure it's not reused for next page
              console.log(`[processBatches] ✅ Abort controller for ${pageUrl} is isolated and won't affect other pages`);
            }
            // Clear reference to ensure it's garbage collected
            pageAbortController = null;
          } catch (abortCheckError: any) {
            // Ignore errors checking abort controller
            console.log(`[processBatches] ✅ Abort controller check completed for ${pageUrl}`);
            pageAbortController = null;
          }
        }
      }
      
      // CRITICAL: After processing all pages in batch, ensure we continue even if batch had errors
      console.log(`[processBatches] ✅ Batch ${batchNumber} completed. Processed ${batch.length} pages.`);
      console.log(`[processBatches] ✅ Successful: ${successful.length}, Failed: ${failed.length}`);
      console.log(`[processBatches] ✅ Continuing to next batch regardless of errors...`);

      // Process results - Sequential: Process each result one by one
      // Note: Results are already saved immediately after audit completes above
      // This loop is mainly for aggregation and error handling
      // CRITICAL: This loop processes results but doesn't affect the main page processing loop
      // Even if results processing fails, the main loop continues
      for (const result of batchResults) {
        try {
          if (result.status === 'fulfilled') {
            successful.push(result.value);
            // Result already saved and status updated above, no need to do it again
          } else {
            const errorCategory = (result.reason as any)?.category || categorizeError(result.reason);
            const failedPage: FailedPage = {
              url: result.url,
              error: errorCategory.message,
              errorType: errorCategory.type,
              retryable: errorCategory.retryable,
            };
            failed.push(failedPage);
            // Failed pages are already marked as failed in the catch block above
            console.log(`[processBatches] 📊 Recorded failed page: ${result.url} - ${errorCategory.message}`);
          }
        } catch (resultError: any) {
          // CRITICAL: Even if result processing fails, don't break the loop
          console.error(`[processBatches] ⚠️ Error processing result for ${result.url}:`, resultError.message);
          // Continue to next result
        }
      }

      // Log batch duration after each batch completes
      const batchDuration = Date.now() - batchStartTime;
      console.log(`[processBatches] ⏱️ Batch ${batchNumber}/${batches.length} duration: ${batchDuration}ms`);
      
      // Log warning if batch took too long (close to Netlify 26s limit)
      const netlifyLimit = 26000;
      const warningThreshold = netlifyLimit - 2000; // Warn at 24s
      if (CONFIG.platform.isNetlify && batchDuration > warningThreshold) {
        console.warn(`[processBatches] ⚠️ WARNING: Batch took ${batchDuration}ms - very close to Netlify ${netlifyLimit/1000}s limit!`);
        console.warn(`[processBatches] ⚠️ Remaining buffer: ${netlifyLimit - batchDuration}ms`);
      }

      // Delay between batches
      if (i < batches.length - 1) {
        await delay(config.delayBetweenBatches);
      }
      
      // CRITICAL: After processing all pages in batch, ensure we continue even if batch had errors
      console.log(`[processBatches] ✅ Batch ${batchNumber} completed. Processed ${batch.length} pages.`);
      console.log(`[processBatches] ✅ Successful: ${successful.length}, Failed: ${failed.length}`);
      console.log(`[processBatches] ✅ Continuing to next batch regardless of errors...`);
    }
  } catch (batchLoopError: any) {
    // CRITICAL: Catch any errors in the batch loop itself
    // This ensures that even if the loop itself fails, we don't stop processing
    console.error(`[processBatches] ❌ CRITICAL: Error in batch processing loop: ${batchLoopError.message}`);
    console.error(`[processBatches] Error stack:`, batchLoopError.stack);
    console.error(`[processBatches] ⚠️ This error occurred in the batch loop itself, not a specific page`);
    console.error(`[processBatches] ⚠️ Processed ${successful.length} successful and ${failed.length} failed pages before error`);
    // Don't re-throw - allow function to complete and return results
  } finally {
    clearInterval(heartbeatInterval);
    // Close shared browser
    if (browser) {
      try {
        console.log(`[processBatches] 🧹 Closing shared browser...`);
        await browser.close();
        console.log(`[processBatches] ✅ Shared browser closed`);
      } catch (e) {
        console.error(`[processBatches] ⚠️ Error closing shared browser:`, e);
      }
    }
    
    const totalDuration = Date.now() - overallStartTime;
    console.log(`[processBatches] ⏱️ Total batch processing duration: ${totalDuration}ms`);
  }

  console.log(`\n✅ Batch processing complete: ${successful.length} successful, ${failed.length} failed`);
  console.log(`[processBatches] Completion timestamp: ${new Date().toISOString()}`);

  return { successful, failed };
}
