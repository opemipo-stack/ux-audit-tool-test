import { NextRequest, NextResponse } from 'next/server';
import { getProgress, updateStatus, updatePageProgress } from '../../../../lib/progressTracker';
import { enqueueInternalJsonPost } from '../../../../lib/qstash';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { jobId, retryUrls } = await request.json();

    if (!jobId) {
      return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
    }

    if (!retryUrls || !Array.isArray(retryUrls) || retryUrls.length === 0) {
      return NextResponse.json({ error: 'Retry URLs are required' }, { status: 400 });
    }

    console.log(`[Retry] 🔄 Retrying ${retryUrls.length} failed pages for job: ${jobId}`);
    console.log(`[Retry] URLs: ${retryUrls.join(', ')}`);

    // 1. Get existing progress
    const progress = await getProgress(jobId);
    if (!progress) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // 2. Verify retry URLs are actually failed pages in this job
    const existingFailedUrls = progress.pageResults
      .filter(p => p.status === 'failed')
      .map(p => p.url);
    
    const invalidUrls = retryUrls.filter(url => !existingFailedUrls.includes(url));
    if (invalidUrls.length > 0) {
      console.warn(`[Retry] ⚠️ Some URLs are not failed pages: ${invalidUrls.join(', ')}`);
    }

    // 3. Reset failed pages to 'pending' status (preserve completed pages)
    // OPTIMIZATION: Batch update all pages at once to reduce DB calls and stay under Netlify timeout
    let resetCount = 0;
    const pagesToReset: string[] = [];
    
    for (const url of retryUrls) {
      const pageIndex = progress.pageResults.findIndex(p => p.url === url);
      if (pageIndex >= 0) {
        const pageResult = progress.pageResults[pageIndex];
        if (pageResult.status === 'failed') {
          pagesToReset.push(url);
          resetCount++;
        } else if (pageResult.status === 'completed') {
          console.log(`[Retry] ⚠️ Skipping ${url} - already completed`);
        } else {
          console.log(`[Retry] ⚠️ Skipping ${url} - status is ${pageResult.status}`);
        }
      } else {
        console.warn(`[Retry] ⚠️ URL not found in job: ${url}`);
      }
    }
    
    // Batch update all pages (more efficient than individual updates)
    // CRITICAL: Do this in parallel to reduce time spent in retry API
    if (pagesToReset.length > 0) {
      console.log(`[Retry] 🔄 Resetting ${pagesToReset.length} pages to pending...`);
      await Promise.all(
        pagesToReset.map(url => updatePageProgress(jobId, url, 'pending'))
      );
      console.log(`[Retry] ✅ Reset ${pagesToReset.length} pages to pending`);
    }

    if (resetCount === 0) {
      return NextResponse.json({ 
        error: 'No failed pages to retry. All specified URLs are already completed or not found.',
        resetCount: 0
      }, { status: 400 });
    }

    // 4. Update job status to 'auditing' before re-queueing the batch worker
    await updateStatus(jobId, 'auditing', `Retrying ${resetCount} failed pages...`);

    // 5. Trigger batch processing for the retry pages via QStash when available
    const queuedBatch = await enqueueInternalJsonPost(request, {
      path: '/api/audit/batch',
      body: { jobId },
      label: 'full-site-manual-retry',
    });
    console.log(`[Retry] ✅ Batch processing queued via ${queuedBatch.mode}: ${queuedBatch.url}`);

    return NextResponse.json({
      success: true,
      jobId,
      resetCount,
      message: `Retry initiated for ${resetCount} failed pages. Processing will continue in the background.`
    });

  } catch (error: any) {
    console.error(`[Retry] ❌ Error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
