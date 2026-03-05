import { NextRequest, NextResponse } from 'next/server';
import { getProgress, updateStatus, updatePageProgress, saveFinalResult, updateAutoRetryRounds, markHomepageRetryQueued } from '../../../../lib/progressTracker';
import { processBatches } from '../../../../lib/batchProcessor';
import { aggregateAuditResults, sortPagesBySeverity } from '../../../../lib/batchAuditor';
import { CONFIG } from '../../../../lib/config';
import { enqueueInternalJsonPost } from '../../../../lib/qstash';

// Vercel serverless function configuration
// Serverless function configuration
// Netlify Pro: 26s timeout max
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
    const functionStartTime = Date.now();
    let jobId: string | undefined; // Declare at function scope for error recovery
    try {
        // Validate request body
        let requestBody;
        try {
            requestBody = await request.json();
        } catch (jsonError: any) {
            console.error(`[Batch] ❌ Invalid JSON in request: ${jsonError.message}`);
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }
        
        jobId = requestBody?.jobId;
        if (!jobId || typeof jobId !== 'string') {
            console.error(`[Batch] ❌ Missing or invalid jobId in request`);
            return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
        }
        const retryMode = requestBody?.retryMode === true;

        console.log(`[Batch] 🚀 Processing batch for Job ID: ${jobId} (start: ${new Date().toISOString()})`);
        console.log(`[Batch] 🔁 Retry mode: ${retryMode ? 'ON (rescue fallback enabled)' : 'OFF'}`);

        // 1. Get current progress
        const progressStartTime = Date.now();
        const progress = await getProgress(jobId);
        const progressDuration = Date.now() - progressStartTime;
        console.log(`[Batch] ⏱️ Progress fetch: ${progressDuration}ms`);
        
        if (!progress) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }

        // 2. Identify pages still to audit (pending + processing - never skip other pages)
        // Include 'processing' so stuck pages from timeout get retried
        const pagesToAudit = progress.pageResults
            .filter(p => p.status !== 'completed' && p.status !== 'failed')
            .map(p => p.url);

        if (pagesToAudit.length === 0) {
            console.log(`[Batch] ✅ No pages left to audit (all completed or failed). Job completed.`);

            if (progress.status !== 'completed') {
                await updateStatus(jobId, 'completed');
            }

            return NextResponse.json({ status: 'completed', message: 'All pages processed' });
        }

        // 3. Process one page at a time (not in batches)
        // Each page gets full 20s timeout, fits within Netlify's 26s limit
        const BATCH_SIZE = 1; // One page at a time - no batching
        
        // CRITICAL: Re-fetch progress right before creating batches
        // This ensures we have the latest status and don't include pages that just completed
        const freshProgress = await getProgress(jobId);
        if (!freshProgress) {
            return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }
        
        // Include BOTH 'pending' and 'processing' pages - never skip other pages
        // 'processing' may be stuck from a previous timed-out invocation (Netlify 26s)
        // so we must retry them or those pages would never be audited
        const verifiedPendingPages = freshProgress.pageResults
            .filter(p => {
                if (p.status === 'completed') {
                    console.log(`[Batch] ⏭️ Excluding ${p.url} - already completed`);
                    return false;
                }
                if (p.status === 'failed') {
                    console.log(`[Batch] ⏭️ Excluding ${p.url} - already failed`);
                    return false;
                }
                if (p.status === 'pending' || p.status === 'processing') {
                    if (p.status === 'processing') {
                        console.log(`[Batch] ✅ Including ${p.url} (was processing - may be stuck, will retry)`);
                    }
                    return true;
                }
                // Unknown status - include to avoid skipping
                console.log(`[Batch] ✅ Including ${p.url} (status: ${p.status})`);
                return true;
            })
            .map(p => p.url);

        if (verifiedPendingPages.length === 0) {
          console.log(`[Batch] ✅ No verified pending pages after re-check. Job completed.`);
          if (freshProgress.status !== 'completed') {
            await updateStatus(jobId, 'completed');
          }
          return NextResponse.json({ status: 'completed', message: 'All pages processed' });
        }
        
        const currentBatchUrls = verifiedPendingPages.slice(0, BATCH_SIZE);
        const totalBatches = Math.ceil(verifiedPendingPages.length / BATCH_SIZE);
        const currentBatchNumber = Math.ceil((freshProgress.totalPages - verifiedPendingPages.length) / BATCH_SIZE) + 1;
        const isFirstBatch = currentBatchNumber === 1;
        const firstBatchUrl = currentBatchUrls[0];

        console.log(`[Batch] 📦 Batch ${currentBatchNumber}/${totalBatches}: Processing ${currentBatchUrls.length} pages`);
        console.log(`[Batch]    URLs: ${currentBatchUrls.join(', ')}`);
        if (isFirstBatch && firstBatchUrl) {
            console.log(`[Batch] 🔥 First-batch hardening active for: ${firstBatchUrl}`);
        }

        // 4. Process one page at a time with original timeouts
        // Each page: 20s timeout (includes page load + AI analysis + DB save)
        // Fits within Netlify's 26s function limit (6s buffer for overhead)
        const batchStartTime = Date.now();
        try {
            const batchResult = await processBatches(currentBatchUrls, jobId, {
                batchSize: BATCH_SIZE, // 1 page at a time
                delayBetweenBatches: 0, // No delay needed for single-page processing
                delayBetweenRequests: CONFIG.batch.delayBetweenRequests, // 500ms delay (original)
                maxRetries: CONFIG.batch.maxRetries, // 2 attempts total = 1 immediate retry
                timeoutPerPage: CONFIG.batch.timeoutPerPage, // 20s per page (original, fits Netlify 26s limit)
                forceFallbackOnError: retryMode,
                firstPageHardening: isFirstBatch,
                firstPageUrl: isFirstBatch ? firstBatchUrl : undefined,
            });
            console.log(`[Batch] ✅ Batch processed: ${batchResult.successful.length} successful, ${batchResult.failed.length} failed`);
        } catch (err: any) {
            console.error(`[Batch] ⚠️ Batch processing error: ${err.message}`);
            console.error(`[Batch] Error stack:`, err.stack);
            // Don't throw - allow function to continue and check remaining pages
        }
        
        const batchDuration = Date.now() - batchStartTime;
        console.log(`[Batch] ⏱️ Batch processing duration: ${batchDuration}ms`);

        // 5. Brief wait so Redis has current page status (stay under Netlify 26s)
        const verifyWaitMs = 400;
        await new Promise(resolve => setTimeout(resolve, verifyWaitMs));
        const verifyProgress = await getProgress(jobId);
        if (verifyProgress) {
            const currentPageResult = verifyProgress.pageResults.find(p => currentBatchUrls.includes(p.url));
            if (currentPageResult) {
                console.log(`[Batch] ✅ Page ${currentPageResult.url} is ${currentPageResult.status}`);
            }
        }

        // 6. Re-check progress to get accurate remaining count
        // CRITICAL: Don't fail if progress check fails - continue processing remaining pages
        let updatedProgress;
        try {
            updatedProgress = await getProgress(jobId);
            if (!updatedProgress) {
                console.error(`[Batch] ⚠️ Could not get updated progress after batch processing - will continue anyway`);
                // Use previous progress as fallback
                updatedProgress = progress;
            }
        } catch (progressError: any) {
            console.error(`[Batch] ⚠️ Error getting updated progress: ${progressError.message} - will continue anyway`);
            // Use previous progress as fallback
            updatedProgress = progress;
        }
        
        if (!updatedProgress) {
            console.error(`[Batch] ⚠️ No progress available - cannot determine remaining pages, but will attempt to continue`);
            // Still try to trigger next batch if we have jobId
            // Don't return error - let the trigger logic handle it
        }
        
        // If the homepage failed first, give it one extra attempt after another page completes.
        if (updatedProgress && updatedProgress.pageResults.length > 1) {
            const homepage = updatedProgress.pageResults[0];
            const homepageIsFailed = homepage?.status === 'failed';
            const homepageRetryQueued = updatedProgress.homepageRetryQueued === true;
            const nonHomepageCompleted = updatedProgress.pageResults
                .slice(1)
                .some(p => p.status === 'completed');

            if (homepageIsFailed && !homepageRetryQueued && nonHomepageCompleted) {
                console.log(`[Batch] 🔄 Requeueing homepage ${homepage.url} for one warm retry after another page completed`);
                await updatePageProgress(jobId, homepage.url, 'pending');
                await markHomepageRetryQueued(jobId);
                updatedProgress = await getProgress(jobId) || updatedProgress;
            }
        }

        // Remaining pages = not completed and not failed (pending + processing)
        // Include 'processing' so stuck pages get retried - never skip other pages
        let remainingPendingPages: string[] = [];
        if (updatedProgress && Array.isArray(updatedProgress.pageResults)) {
            remainingPendingPages = updatedProgress.pageResults
                .filter(p => {
                    const status = p.status;
                    if (status === 'completed' || status === 'failed') {
                        return false;
                    }
                    // pending or processing - need to be audited
                    return true;
                })
                .map(p => p.url);
        } else {
            console.warn(`[Batch] ⚠️ Could not get page results - will attempt to continue with available information`);
            try {
                const fallbackProgress = await getProgress(jobId);
                if (fallbackProgress && Array.isArray(fallbackProgress.pageResults)) {
                    remainingPendingPages = fallbackProgress.pageResults
                        .filter(p => p.status !== 'completed' && p.status !== 'failed')
                        .map(p => p.url);
                }
            } catch (fallbackError: any) {
                console.error(`[Batch] ⚠️ Fallback progress check also failed: ${fallbackError.message}`);
            }
        }

        console.log(`[Batch] 📊 After page completion: ${remainingPendingPages.length} pages still pending`);
        if (updatedProgress) {
            console.log(`[Batch]    Completed: ${updatedProgress.completedPages}/${updatedProgress.totalPages}`);
            console.log(`[Batch]    Total pages in progress: ${updatedProgress.pageResults.length}`);
            console.log(`[Batch]    Page statuses: ${updatedProgress.pageResults.map(p => `${p.url}:${p.status}`).join(', ')}`);
            
            // CRITICAL: Verify all pages are accounted for
            const completedCount = updatedProgress.pageResults.filter(p => p.status === 'completed').length;
            const failedCount = updatedProgress.pageResults.filter(p => p.status === 'failed').length;
            const pendingCount = updatedProgress.pageResults.filter(p => p.status === 'pending').length;
            const processingCount = updatedProgress.pageResults.filter(p => p.status === 'processing').length;
            
            console.log(`[Batch]    Status breakdown: ${completedCount} completed, ${failedCount} failed, ${pendingCount} pending, ${processingCount} processing`);
            
            if (updatedProgress.pageResults.length !== updatedProgress.totalPages) {
                console.error(`[Batch] ❌ CRITICAL: Page count mismatch! pageResults.length (${updatedProgress.pageResults.length}) !== totalPages (${updatedProgress.totalPages})`);
            }
        } else {
            console.log(`[Batch]    Progress unavailable - continuing anyway`);
        }

        // 7. Trigger next page WITHOUT waiting (fire-and-forget)
        // CRITICAL: Netlify kills the function at 26s. If we AWAIT the next batch response,
        // we exceed 26s and get killed before the trigger completes. So we fire the request
        // and return immediately so all pages get audited.
        if (remainingPendingPages.length > 0) {
            const nextBatchNumber = currentBatchNumber + 1;
            console.log(`[Batch] 🔄 Triggering next page ${nextBatchNumber}/${totalBatches} (${remainingPendingPages.length} pages remaining) - fire-and-forget`);

            const origin = new URL(request.url).origin;
            const nextBatchUrl = `${origin}/api/audit/batch`;

            fetch(nextBatchUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, retryMode })
            }).then((res) => {
                if (res.ok) {
                    console.log(`[Batch] ✅ Next page ${nextBatchNumber} triggered successfully`);
                } else {
                    console.error(`[Batch] ❌ Next batch returned ${res.status}`);
                }
            }).catch((err: any) => {
                console.error(`[Batch] ❌ Next batch trigger failed: ${err.message}`);
                setTimeout(() => {
                    fetch(nextBatchUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobId, retryMode })
                    }).then((r) => console.log(`[Batch] 🔄 Retry trigger: ${r.ok ? 'ok' : r.status}`)).catch((e: any) => console.error(`[Batch] ❌ Retry trigger failed: ${e.message}`));
                }, 1000);
            });

            console.log(`[Batch] ✅ Next page trigger sent (not waiting for response)`);
        } else {
            // No more pages, we are done
            console.log(`[Batch] ✅ Final batch completed.`);

            const finalProgress = await getProgress(jobId);
            const failedPageResults = finalProgress
                ? finalProgress.pageResults.filter(p => p.status === 'failed')
                : [];
            const autoRetryRoundsCompleted = finalProgress?.autoRetryRoundsCompleted || 0;
            const maxAutoRetryRounds = CONFIG.batch.autoRetryRounds || 0;

            if (failedPageResults.length > 0 && autoRetryRoundsCompleted < maxAutoRetryRounds) {
                const nextAutoRetryRound = autoRetryRoundsCompleted + 1;
                const retryUrls = failedPageResults.map(p => p.url);

                console.log(`[Batch] 🔄 Auto-retrying ${retryUrls.length} failed pages (round ${nextAutoRetryRound}/${maxAutoRetryRounds})`);

                await updateAutoRetryRounds(jobId, nextAutoRetryRound);

                const queuedRetry = await enqueueInternalJsonPost(request, {
                    path: '/api/audit/retry',
                    body: { jobId, retryUrls, retryMode: true },
                    label: 'full-site-auto-retry',
                });
                console.log(`[Batch] ✅ Auto-retry queued via ${queuedRetry.mode}: ${queuedRetry.url}`);

                return NextResponse.json({
                    status: 'auto-retrying',
                    retriedPages: retryUrls.length,
                    autoRetryRound: nextAutoRetryRound,
                    maxAutoRetryRounds
                });
            }

            // Trigger final aggregation
            try {
                const { getAllPageResults } = await import('../../../../lib/progressTracker');
                const allResults = await getAllPageResults(jobId);

                if (allResults.length > 0) {
                    console.log(`[Batch] 📊 Aggregating ${allResults.length} page results...`);
                    const aggregated = aggregateAuditResults(allResults, allResults[0].url); // Use first URL as base?
                    const sortedPages = sortPagesBySeverity(allResults);

                    // Fetch current progress to get failed pages list
                    const finalProgress = await getProgress(jobId);
                    
                    // CRITICAL FIX: Exclude URLs from failedPages that were successfully retried
                    // Get all successful URLs from results
                    const successfulUrls = new Set(allResults.map(r => r.url));
                    
                    // Filter failed pages: only include pages that are still failed AND not in successful results
                    const failedPages = finalProgress 
                        ? finalProgress.pageResults.filter(p => {
                            const isFailed = p.status === 'failed';
                            const wasRetriedAndSucceeded = successfulUrls.has(p.url);
                            
                            // Only include if failed AND not successfully retried
                            if (isFailed && wasRetriedAndSucceeded) {
                                console.log(`[Batch] ✅ Excluding ${p.url} from failedPages - was retried and succeeded`);
                                return false;
                            }
                            return isFailed;
                        })
                        : [];

                    console.log(`[Batch] 📊 Failed pages after filtering: ${failedPages.length} (excluded ${finalProgress ? finalProgress.pageResults.filter(p => p.status === 'failed' && successfulUrls.has(p.url)).length : 0} successfully retried pages)`);

                    await saveFinalResult(jobId, {
                        aggregated,
                        sortedPages,
                        pageResults: allResults,
                        failedPages: failedPages.map(p => ({
                            url: p.url,
                            error: 'Audit failed', // We might need better error tracking in KV, but this is a start
                            errorType: 'unknown',
                            retryable: true
                        })),
                        isMockData: false
                    });
                    console.log(`[Batch] ✅ Final aggregation completed and saved.`);
                } else {
                    console.warn(`[Batch] ⚠️ No results found to aggregate.`);
                    await updateStatus(jobId, 'completed');
                }

            } catch (aggError: any) {
                console.error(`[Batch] ❌ Aggregation error:`, aggError);
                // Ensure we at least mark as completed so UI doesn't hang
                await updateStatus(jobId, 'completed');
            }
        }

        const totalFunctionDuration = Date.now() - functionStartTime;
        const netlifyLimit = 26000;
        const platform = CONFIG.platform.isNetlify ? 'Netlify' : CONFIG.platform.isVercel ? 'Vercel' : 'Local';
        console.log(`[Batch] ⏱️ Total function duration: ${totalFunctionDuration}ms (${platform} limit: ${CONFIG.platform.isNetlify ? netlifyLimit : 'N/A'}ms)`);
        
        if (CONFIG.platform.isNetlify && totalFunctionDuration > netlifyLimit - 2000) {
            console.warn(`[Batch] ⚠️ WARNING: Function took ${totalFunctionDuration}ms - close to Netlify ${netlifyLimit/1000}s limit!`);
            console.warn(`[Batch] ⚠️ Remaining buffer: ${netlifyLimit - totalFunctionDuration}ms`);
        }

        return NextResponse.json({
            status: 'processing',
            processed: currentBatchUrls.length,
            remaining: remainingPendingPages.length,
            totalPages: updatedProgress?.totalPages || progress.totalPages,
            completedPages: updatedProgress?.completedPages || progress.completedPages,
            currentBatch: currentBatchNumber,
            totalBatches: totalBatches,
            functionDuration: totalFunctionDuration
        });

    } catch (error: any) {
        const totalFunctionDuration = Date.now() - functionStartTime;
        console.error(`[Batch] ❌ Critical error after ${totalFunctionDuration}ms: ${error.message}`);
        console.error(`[Batch] Error stack:`, error.stack);
        
        // CRITICAL: Even on critical error, try to trigger next batch if possible
        // This ensures processing continues even if this function fails
        if (jobId) {
            try {
                const errorProgress = await getProgress(jobId);
                if (errorProgress) {
                    const errorPendingPages = errorProgress.pageResults
                        .filter(p => p.status !== 'completed' && p.status !== 'failed')
                        .map(p => p.url);
                    
                    if (errorPendingPages.length > 0) {
                        console.log(`[Batch] 🔄 Attempting to trigger next batch despite error (${errorPendingPages.length} pages remaining)...`);
                        const origin = new URL(request.url).origin;
                        const nextBatchUrl = `${origin}/api/audit/batch`;
                        
                        setTimeout(async () => {
                            try {
                                await fetch(nextBatchUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ jobId, retryMode })
                                });
                                console.log(`[Batch] ✅ Error recovery: Next batch triggered successfully`);
                            } catch (recoveryError: any) {
                                console.error(`[Batch] ❌ Error recovery trigger failed: ${recoveryError.message}`);
                            }
                        }, 1000);
                    }
                }
            } catch (recoveryCheckError: any) {
                console.error(`[Batch] ⚠️ Could not attempt error recovery: ${recoveryCheckError.message}`);
            }
        } else {
            console.error(`[Batch] ⚠️ Cannot attempt error recovery - jobId not available`);
        }
        
        // Return error but don't prevent continuation
        return NextResponse.json({ 
            error: error.message,
            message: 'Batch processing encountered an error, but will attempt to continue processing remaining pages.',
            ...(jobId && { jobId })
        }, { status: 500 });
    }
}
