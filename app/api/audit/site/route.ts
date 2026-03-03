import { NextRequest, NextResponse } from 'next/server';
import { discoverPagesWithDepth } from '../../../../lib/crawler';
import { aggregateAuditResults, sortPagesBySeverity } from '../../../../lib/batchAuditor';
import { createProgressTracker, updateStatus, getProgress, getAllJobs, debugProgressStore, updatePageProgress, saveFinalResult } from '../../../../lib/progressTracker';
import { processBatches, FailedPage } from '../../../../lib/batchProcessor';
import { generateMockPages, generateMockAuditForPage } from '../../../../lib/mockData';

// Serverless function configuration
// Note: Netlify Pro has 26s timeout, so we use background processing
export const runtime = 'nodejs';

// Simple UUID generator
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export async function POST(request: NextRequest) {
  try {
    const { url, maxPages = 40, maxDepth = 3, useMockData = false, retryUrls, jobId: incomingJobId } = await request.json();

    // Check environment variable for mock data mode
    const forceMockData = process.env.USE_MOCK_DATA === 'true' || useMockData;

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // Validate URL
    let targetUrl: URL;
    try {
      targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    // Generate job ID if not provided by queued starter
    const jobId = incomingJobId || generateUUID();

    // Initialize progress tracker immediately (before async operation)
    // This ensures the job exists for polling even before discovery starts
    const initialPageCount = retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0 
      ? retryUrls.length 
      : 1; // Temporary, will be updated after discovery
    
    const initialProgress = await createProgressTracker(jobId, initialPageCount);
    
    if (retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0) {
      // Retry mode: Set up pages immediately
      initialProgress.pageResults = retryUrls.map(url => ({
        url,
        status: 'pending' as const,
      }));
      await updateStatus(jobId, 'auditing', `Retrying ${retryUrls.length} failed pages...`);
    } else {
      // Normal mode: Single placeholder page
      initialProgress.pageResults = [{
        url: targetUrl.toString(),
        status: 'pending' as const,
      }];
      await updateStatus(jobId, 'discovering');
    }

    // Verify job was created and can be retrieved immediately
    // Add retry logic for KV latency in production
    let verifyJob = await getProgress(jobId);
    let retryCount = 0;
    const maxRetries = 5;

    while (!verifyJob && retryCount < maxRetries) {
      console.log(`   Retrying getProgress for jobId: ${jobId}, attempt ${retryCount + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 200)); // Wait 200ms
      verifyJob = await getProgress(jobId);
      retryCount++;
    }

    if (!verifyJob) {
      console.error('❌ CRITICAL: Job not found immediately after creation, even after retries');
      await debugProgressStore();

      // Check if we're in production without Redis
      const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
      const hasRedisUrl = !!process.env.REDIS_URL;

      if (isProduction && !hasRedisUrl) {
        return NextResponse.json(
          {
            error: 'Failed to initialize audit job',
            message: 'REDIS_URL is not configured. Progress tracking requires Redis in production. Please set REDIS_URL environment variable in Vercel (Settings → Environment Variables).',
            jobId,
            debug: {
              hasRedisUrl: false,
              isProduction,
            }
          },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          error: 'Failed to initialize audit job',
          jobId
        },
        { status: 500 }
      );
    }

    console.log('✅ Job created and verified:', jobId);
    console.log('   Job status:', verifyJob.status);
    console.log('   Total pages:', verifyJob.totalPages);
    await debugProgressStore();

    // Start page discovery and audit process in background
    // CRITICAL: Background work will continue processing (Netlify compatible)
    // This prevents Vercel from terminating the background work
    const backgroundPromise = (async () => {
      let backgroundError: any = null;
      try {
        // Ensure Redis/KV is initialized before starting
        // Force initialization - it's handled internally in progressTracker
        // Just ensure we've imported and called getProgress to trigger initialization
        const testProgress = await getProgress(jobId);
        if (!testProgress) {
          console.error('[Background] ❌ CRITICAL: Cannot get progress after job creation');
        }

        console.log(`[Background] Starting full-site audit for ${targetUrl.toString()}...`);
        console.log(`[Background] Job ID: ${jobId}`);

        let pageUrls: string[];
        let actualPageCount: number;

        // Check if this is a retry request (has retryUrls)
        if (retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0) {
          // Retry mode: Skip discovery and use provided URLs directly
          console.log(`[Background] 🔄 Retry mode: Processing ${retryUrls.length} failed URLs`);
          pageUrls = retryUrls;
          actualPageCount = retryUrls.length;
          
          // Update status to auditing (skip discovery phase)
          await updateStatus(jobId, 'auditing', `Retrying ${actualPageCount} failed pages...`);
        } else {
          // Normal mode: Discover pages
          console.log(`[Background] 🔍 Discovering pages for ${targetUrl.toString()}...`);
          await updateStatus(jobId, 'discovering', 'Starting page discovery...');

          // Persist status immediately to ensure it's saved
          const discoverStatusCheck = await getProgress(jobId);
          if (!discoverStatusCheck || discoverStatusCheck.status !== 'discovering') {
            console.error('[Background] ⚠️ Status not persisted, retrying...');
            await updateStatus(jobId, 'discovering', 'Starting page discovery...');
          }

          // Discovery timeout: on Netlify use 20s so we have ~6s left to update status and fire first batch (26s limit)
          const discoveryTimeoutMs = process.env.NETLIFY ? 20000 : 60000;
          const discoveryPromise = discoverPagesWithDepth(targetUrl.toString(), {
            maxPages,
            maxDepth,
          });

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Discovery timeout: Page discovery took longer than ${discoveryTimeoutMs / 1000} seconds`)), discoveryTimeoutMs)
          );

          let discoveredPages: Awaited<ReturnType<typeof discoverPagesWithDepth>>;
          try {
            discoveredPages = await Promise.race([discoveryPromise, timeoutPromise]);
          } catch (discoveryError: any) {
            console.error('❌ Discovery failed or timed out:', discoveryError.message);
            await updateStatus(jobId, 'failed');
            await saveFinalResult(jobId, {
              error: `Page discovery failed: ${discoveryError.message}`,
              errorType: 'discovery_failed',
              failedPages: [],
              aggregated: null,
              sortedPages: [],
              pageResults: [],
              isMockData: false,
            });
            return;
          }

          pageUrls = discoveredPages.map(page => page.url);
          actualPageCount = Math.min(pageUrls.length, maxPages);

          // On Netlify, the homepage is often the coldest request on the target origin.
          // Audit another discovered page first, then come back to the homepage once the site is warm.
          if (process.env.NETLIFY && pageUrls.length > 1) {
            const homepageIndex = pageUrls.findIndex((pageUrl) => {
              try {
                const candidate = new URL(pageUrl);
                return candidate.origin === targetUrl.origin && candidate.pathname === '/';
              } catch {
                return false;
              }
            });

            if (homepageIndex === 0) {
              const [homepageUrl] = pageUrls.splice(homepageIndex, 1);
              pageUrls.push(homepageUrl);
              console.log(`[Background] 🔄 Moved homepage to the end of the queue for warm-start stability: ${homepageUrl}`);
            }
          }

          console.log(`✅ Discovered ${pageUrls.length} pages (requested: ${maxPages}, will audit: ${actualPageCount})`);
          
          // CRITICAL: Log if we didn't discover the requested number of pages
          if (pageUrls.length < maxPages) {
            console.warn(`⚠️ WARNING: Only discovered ${pageUrls.length} pages, but requested ${maxPages} pages`);
            console.warn(`⚠️ This may be because:`);
            console.warn(`   - The website has fewer than ${maxPages} pages`);
            console.warn(`   - Discovery timeout (45s) was reached`);
            console.warn(`   - Sitemap doesn't contain ${maxPages} pages`);
            console.warn(`   - Depth-based crawling didn't find ${maxPages} pages`);
          } else {
            console.log(`✅ Successfully discovered ${pageUrls.length} pages (requested: ${maxPages})`);
          }
        }

        // Update progress tracker with discovered pages (or retry URLs)
        let progress = await getProgress(jobId);
        if (!progress) {
          console.error('❌ CRITICAL: Job not found after discovery/retry setup');
          // Try to recreate the job
          progress = await createProgressTracker(jobId, actualPageCount);
        }

        // For retry mode, ensure we don't overwrite existing pending pages
        // For normal mode, update with discovered pages
        if (retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0) {
          // Retry mode: Verify pages are set correctly (they should already be set in initial setup)
          console.log(`[Background] 🔄 Retry mode: Verifying ${retryUrls.length} retry URLs are set as pending`);
          const existingUrls = progress.pageResults.map(p => p.url);
          const retryUrlsSet = new Set(retryUrls);
          
          // Check if all retry URLs are present and marked as pending
          const missingUrls = retryUrls.filter(url => !existingUrls.includes(url));
          if (missingUrls.length > 0) {
            console.warn(`[Background] ⚠️ Some retry URLs missing from progress, adding them: ${missingUrls.join(', ')}`);
            missingUrls.forEach(url => {
              progress.pageResults.push({
                url,
                status: 'pending' as const,
              });
            });
          }
          
          // Ensure all retry URLs are marked as pending (in case they were marked as failed)
          progress.pageResults.forEach(pageResult => {
            if (retryUrlsSet.has(pageResult.url) && pageResult.status !== 'pending') {
              console.log(`[Background] 🔄 Resetting ${pageResult.url} from ${pageResult.status} to pending for retry`);
              pageResult.status = 'pending';
            }
          });
          
          progress.totalPages = retryUrls.length;
        } else {
          // Normal mode: Update with discovered pages
          progress.totalPages = actualPageCount;
          progress.pageResults = pageUrls.slice(0, actualPageCount).map(url => ({
            url,
            status: 'pending' as const,
          }));
        }

        // Save updated progress - ensure it's persisted
        const pendingCount = progress.pageResults.filter(p => p.status === 'pending').length;
        console.log(`[Background] 📝 Progress has ${progress.pageResults.length} pages (${pendingCount} pending)...`);
        console.log(`[Background] 📊 Total pages to audit: ${progress.totalPages}`);
        console.log(`[Background] 📋 Page URLs: ${progress.pageResults.map(p => p.url).join(', ')}`);
        
        // CRITICAL: Verify all pages are properly set
        if (progress.pageResults.length !== progress.totalPages) {
          console.error(`[Background] ❌ CRITICAL: Page count mismatch! pageResults.length (${progress.pageResults.length}) !== totalPages (${progress.totalPages})`);
        } else {
          console.log(`[Background] ✅ Page count verified: ${progress.pageResults.length} pages match totalPages`);
        }
        
        // For retry mode, verify all retry URLs are marked as pending
        if (retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0) {
          console.log(`[Background] 🔄 Retry URLs: ${retryUrls.join(', ')}`);
          const pendingUrls = progress.pageResults.filter(p => p.status === 'pending').map(p => p.url);
          console.log(`[Background] 🔄 Pending pages: ${pendingUrls.join(', ')}`);
          
          // Verify all retry URLs are marked as pending
          const notPending = retryUrls.filter(url => !pendingUrls.includes(url));
          if (notPending.length > 0) {
            console.error(`[Background] ❌ ERROR: Some retry URLs are not pending: ${notPending.join(', ')}`);
          }
        }
        
        console.log(`[Background] 📝 Updating status to 'auditing'...`);
        const statusMessage = retryUrls && Array.isArray(retryUrls) && retryUrls.length > 0
          ? `Retrying ${actualPageCount} failed pages, starting audit...`
          : `Found ${actualPageCount} pages, starting audit...`;
        await updateStatus(jobId, 'auditing', statusMessage);

        // Double-check it was saved with retries
        let verifyProgress = await getProgress(jobId);
        let verifyRetries = 0;
        const maxVerifyRetries = 5;

        while ((!verifyProgress || verifyProgress.status !== 'auditing') && verifyRetries < maxVerifyRetries) {
          console.log(`[Background] ⚠️ Status verification failed (attempt ${verifyRetries + 1}/${maxVerifyRetries})`);
          console.log(`[Background]    Current status: ${verifyProgress?.status || 'null'}`);
          console.log(`[Background]    Expected status: auditing`);

          await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
          await updateStatus(jobId, 'auditing', `Found ${actualPageCount} pages, starting audit...`);
          verifyProgress = await getProgress(jobId);
          verifyRetries++;
        }

        if (!verifyProgress || verifyProgress.status !== 'auditing') {
          console.error(`[Background] ❌ CRITICAL: Status update failed after ${maxVerifyRetries} retries`);
          console.error(`[Background]    Final status: ${verifyProgress?.status || 'null'}`);
          throw new Error('Failed to persist status update to auditing');
        }

        console.log(`[Background] ✅ Status verified: ${verifyProgress.status}`);
        console.log(`[Background] ✅ Updated job with ${actualPageCount} pages`);
        await debugProgressStore();

        // Step 2: Trigger recursive batch processing (fire-and-forget)
        // CRITICAL: Do NOT await - Netlify kills the function at 26s. If we await the batch
        // response (~22s), we exceed 26s and get killed before the trigger completes.
        // Fire-and-forget ensures we stay under 26s; the batch runs in a separate invocation.
        // If the trigger fails, progress polling will see 'auditing' and client can resume via
        // SiteAuditProgress STUCK_THRESHOLD (trigger batch after no progress for 28s).
        console.log(`[Background] 🔄 Handing off to batch processor for ${actualPageCount} pages...`);

        const batchApiUrl = `${new URL(request.url).origin}/api/audit/batch`;
        console.log(`[Background] 🔗 Triggering first batch at: ${batchApiUrl} (fire-and-forget)`);

        fetch(batchApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId })
        }).then((res) => {
          if (res.ok) {
            console.log(`[Background] 🚀 First batch triggered successfully`);
          } else {
            console.error(`[Background] ❌ First batch returned ${res.status}`);
          }
        }).catch((triggerError: any) => {
          console.error(`[Background] ❌ Failed to trigger first batch: ${triggerError.message}`);
          updateStatus(jobId, 'failed').catch(() => {});
          saveFinalResult(jobId, {
            error: `Failed to start batch processing: ${triggerError.message}`,
            errorType: 'batch_trigger_failed',
            failedPages: [],
            aggregated: null,
            sortedPages: [],
            pageResults: [],
            isMockData: false
          }).catch(() => {});
        });
      } catch (error: any) {
        // Global background error handler
        backgroundError = error;
        console.error('[Background] ❌ Full-site audit error:', error);

        try {
          const finalProgress = await getProgress(jobId);
          if (finalProgress) {
            await saveFinalResult(jobId, {
              error: error.message || 'Unknown error occurred',
              errorType: 'audit_failed',
              failedPages: finalProgress.pageResults.filter(p => p.status === 'failed').map(p => ({
                url: p.url,
                error: 'Audit process failed',
                errorType: 'unknown' as const,
                retryable: true,
              })),
              aggregated: null,
              sortedPages: [],
              pageResults: [],
              isMockData: false,
            });
          }
        } catch (e) {
          console.error('[Background] Failed to save error status:', e);
        }
      }
    })();

    // CRITICAL: Start background work (Netlify compatible)
    // On Netlify, the function will continue until timeout (26s on Pro)
    // Background work will execute, but may be terminated after response
    // The recursive batch calls ensure processing continues
    backgroundPromise.catch((error) => {
      console.error('[Background] Background promise rejected:', error);
    });
    console.log('✅ Background work started - will continue processing');

    // CRITICAL FIX: Wait a bit for discovery to start before returning
    // This gives the background function time to initialize
    console.log('⏳ Waiting 3 seconds for discovery to initialize...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const earlyCheck = await getProgress(jobId);
    if (earlyCheck && (earlyCheck.status === 'discovering' || earlyCheck.status === 'auditing')) {
      console.log(`✅ Discovery started successfully - status: ${earlyCheck.status}`);
    } else {
      console.log(`⚠️ Discovery may not have started yet - status: ${earlyCheck?.status || 'unknown'}`);
    }

    // CRITICAL: Verify job exists in Redis/KV before returning (with multiple attempts)
    // This ensures the job is persisted and can be retrieved by the progress API
    let verifyProgress = await getProgress(jobId);
    let verifyAttempts = 0;
    const maxVerifyAttempts = 10; // Increased retries for Redis latency

    while (!verifyProgress && verifyAttempts < maxVerifyAttempts) {
      verifyAttempts++;
      console.log(`   Verification attempt ${verifyAttempts}/${maxVerifyAttempts}...`);

      // Wait progressively longer (exponential backoff)
      const waitTime = Math.min(100 * Math.pow(1.5, verifyAttempts - 1), 1000);
      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Try to re-save the job if it's not found
      if (verifyAttempts === 3 || verifyAttempts === 6) {
        console.log(`   Re-saving job to KV on attempt ${verifyAttempts}...`);
        const currentProgress = await getProgress(jobId);
        if (currentProgress) {
          // Force save to KV by updating status
          await updateStatus(jobId, currentProgress.status, currentProgress.currentPage);
        } else {
          // If still not found, try to recreate it
          console.log(`   Job not found, attempting to recreate...`);
          await createProgressTracker(jobId, 1);
          await updateStatus(jobId, 'discovering');
        }
      }

      verifyProgress = await getProgress(jobId);

      if (verifyProgress) {
        console.log(`   ✅ Job verified on attempt ${verifyAttempts}`);
        break;
      }
    }

    if (!verifyProgress) {
      console.error('❌ CRITICAL: Failed to verify job in Redis after', maxVerifyAttempts, 'attempts');
      console.error('   Job ID:', jobId);

      // Check Redis status
      const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
      const hasRedisUrl = !!process.env.REDIS_URL;

      await debugProgressStore();

      if (isProduction && !hasRedisUrl) {
        return NextResponse.json(
          {
            error: 'Failed to persist audit job',
            message: 'REDIS_URL is not configured. Progress tracking requires Redis in production. Please set REDIS_URL environment variable in Vercel (Settings → Environment Variables).',
            jobId,
            debug: {
              hasRedisUrl: false,
              isProduction,
            }
          },
          { status: 500 }
        );
      }

      // Even if verification fails, return jobId so client can try polling
      // The job might be saved but Redis might have latency
      console.warn('⚠️ Job verification failed, but returning jobId anyway (may be Redis latency)');
    }

    console.log('✅ Job ID ready for polling:', jobId);
    if (verifyProgress) {
      console.log('   Final verification - Job status:', verifyProgress.status);
      console.log('   Final verification - Total pages:', verifyProgress.totalPages);
    } else {
      console.log('   ⚠️ Job verification failed - client should retry polling');
    }
    await debugProgressStore();

    // Return job ID immediately with initial progress for client-side caching
    // This helps in serverless environments where in-memory storage may not persist
    return NextResponse.json({
      jobId,
      status: 'started',
      message: 'Full-site audit started. Use the jobId to check progress.',
      initialProgress: verifyProgress ? {
        status: verifyProgress.status,
        totalPages: verifyProgress.totalPages,
        completedPages: verifyProgress.completedPages,
        percentage: verifyProgress.percentage,
      } : {
        status: 'discovering' as const,
        totalPages: 1,
        completedPages: 0,
        percentage: 0,
      },
    });
  } catch (error: any) {
    console.error('❌ Audit error:', error);
    console.error('   Error name:', error?.name);
    console.error('   Error message:', error?.message);
    console.error('   Error stack:', error?.stack);
    console.error('   Error type:', typeof error);

    // Provide more detailed error information
    const errorMessage = error?.message || 'Failed to start full-site audit';
    const errorDetails = {
      message: errorMessage,
      name: error?.name || 'UnknownError',
      ...(process.env.NODE_ENV === 'development' && {
        stack: error?.stack,
        fullError: error?.toString(),
      }),
    };

    return NextResponse.json(
      {
        error: errorMessage,
        details: errorDetails,
        ...(process.env.NODE_ENV === 'development' && {
          debug: {
            errorType: typeof error,
            hasStack: !!error?.stack,
            hasMessage: !!error?.message,
          },
        }),
      },
      { status: 500 }
    );
  }
}
