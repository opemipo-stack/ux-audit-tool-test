import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@upstash/qstash';
import { auditSinglePage } from '../../../../lib/auditHelper';
import { createProgressTracker, saveFinalResult, updatePageProgress, updateStatus } from '../../../../lib/progressTracker';

type StartPayload = {
  url?: string;
};

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }
  const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

function createQstashClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error('QSTASH_TOKEN is not configured');
  }

  const baseUrl = process.env.QSTASH_URL;
  return baseUrl ? new Client({ token, baseUrl }) : new Client({ token });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function resolveCallbackBaseUrl(request: NextRequest): string {
  const configuredBaseUrl = process.env.QSTASH_CALLBACK_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return new URL(configuredBaseUrl).origin;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
    throw new Error('Unable to determine callback URL. Set QSTASH_CALLBACK_BASE_URL to your public app URL.');
  }
}

async function runSingleAuditJobLocally(jobId: string, url: string): Promise<void> {
  try {
    await updateStatus(jobId, 'auditing', url);
    await updatePageProgress(jobId, url, 'processing');

    const result = await auditSinglePage(url);
    const score = result.summary?.overallScore;

    await updatePageProgress(jobId, url, 'completed', score);
    await saveFinalResult(jobId, result);
  } catch (error: any) {
    const message = error?.message || 'Local background audit failed';
    await updatePageProgress(jobId, url, 'failed');
    await saveFinalResult(jobId, { error: message, errorType: 'local_queue_worker_failed' });
  }
}

export async function POST(request: NextRequest) {
  let jobId = '';
  let normalizedUrl = '';

  try {
    const body = (await request.json()) as StartPayload;
    normalizedUrl = normalizeUrl(body.url || '');
    jobId = crypto.randomUUID();

    const progress = await createProgressTracker(jobId, 1);
    progress.pageResults = [{ url: normalizedUrl, status: 'pending' }];
    await updateStatus(jobId, 'discovering', 'Queued for background processing');

    const callbackBaseUrl = resolveCallbackBaseUrl(request);
    const queueEndpoint = `${callbackBaseUrl.replace(/\/$/, '')}/api/audit/queue`;
    const queueHost = new URL(queueEndpoint).hostname;

    if (isLoopbackHost(queueHost)) {
      // QStash rejects loopback/private destinations in local dev. Run worker flow in-process.
      void runSingleAuditJobLocally(jobId, normalizedUrl);
      return NextResponse.json(
        {
          jobId,
          status: 'queued-local',
        },
        { status: 202 }
      );
    }

    const qstash = createQstashClient();

    await qstash.publishJSON({
      url: queueEndpoint,
      body: {
        jobId,
        url: normalizedUrl,
      },
      retries: 3,
      timeout: 25,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      deduplicationId: `audit-${jobId}`,
      label: 'single-audit',
    });

    return NextResponse.json(
      {
        jobId,
        status: 'queued',
      },
      { status: 202 }
    );
  } catch (error: any) {
    const message = error?.message || 'Failed to queue audit job';
    const status = message.includes('URL') ? 400 : 500;
    return NextResponse.json({ error: message, jobId, url: normalizedUrl }, { status });
  }
}
