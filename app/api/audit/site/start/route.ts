import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@upstash/qstash';
import { createProgressTracker, updateStatus } from '../../../../../lib/progressTracker';

type StartSitePayload = {
  url?: string;
  maxPages?: number;
  maxDepth?: number;
  useMockData?: boolean;
  retryUrls?: string[];
};

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }
  const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
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

function createQstashClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error('QSTASH_TOKEN is not configured');
  }

  const baseUrl = process.env.QSTASH_URL;
  return baseUrl ? new Client({ token, baseUrl }) : new Client({ token });
}

export async function POST(request: NextRequest) {
  let jobId = '';

  try {
    const body = (await request.json()) as StartSitePayload;
    const normalizedUrl = normalizeUrl(body.url || '');
    const maxPages = typeof body.maxPages === 'number' ? body.maxPages : 40;
    const maxDepth = typeof body.maxDepth === 'number' ? body.maxDepth : 3;
    const useMockData = body.useMockData === true;
    const retryUrls = Array.isArray(body.retryUrls) ? body.retryUrls : undefined;

    jobId = crypto.randomUUID();

    const initialPageCount = retryUrls && retryUrls.length > 0 ? retryUrls.length : 1;
    const progress = await createProgressTracker(jobId, initialPageCount);
    progress.pageResults = [{ url: normalizedUrl, status: 'pending' }];
    await updateStatus(jobId, 'discovering', 'Queued for background processing');

    const callbackBaseUrl = resolveCallbackBaseUrl(request);
    const siteEndpoint = `${callbackBaseUrl.replace(/\/$/, '')}/api/audit/site`;
    const siteHost = new URL(siteEndpoint).hostname;

    const payload = {
      jobId,
      url: normalizedUrl,
      maxPages,
      maxDepth,
      useMockData,
      retryUrls,
    };

    if (isLoopbackHost(siteHost)) {
      // Local dev fallback: QStash cannot call loopback destinations.
      void fetch(siteEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return NextResponse.json({ jobId, status: 'queued-local' }, { status: 202 });
    }

    const qstash = createQstashClient();
    await qstash.publishJSON({
      url: siteEndpoint,
      body: payload,
      retries: 3,
      timeout: 25,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      deduplicationId: `site-audit-${jobId}`,
      label: 'full-site-audit-start',
    });

    return NextResponse.json({ jobId, status: 'queued' }, { status: 202 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Failed to queue full-site audit', jobId },
      { status: 500 }
    );
  }
}
