import { Client } from '@upstash/qstash';
import { NextRequest } from 'next/server';

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function resolvePublicOrigin(request: NextRequest): string {
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

function createQstashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) {
    return null;
  }

  const baseUrl = process.env.QSTASH_URL?.trim();
  return baseUrl ? new Client({ token, baseUrl }) : new Client({ token });
}

type EnqueueJsonPostOptions = {
  path: string;
  body: unknown;
  label: string;
  timeout?: number;
  retries?: number;
  deduplicationId?: string;
};

export async function enqueueInternalJsonPost(
  request: NextRequest,
  options: EnqueueJsonPostOptions
): Promise<{ mode: 'qstash' | 'fetch'; url: string }> {
  const origin = resolvePublicOrigin(request);
  const normalizedPath = options.path.startsWith('/') ? options.path : `/${options.path}`;
  const url = `${origin.replace(/\/$/, '')}${normalizedPath}`;
  const hostname = new URL(url).hostname;
  const qstash = createQstashClient();

  if (!isLoopbackHost(hostname) && qstash) {
    try {
      await qstash.publishJSON({
        url,
        body: options.body,
        retries: options.retries ?? 3,
        timeout: options.timeout ?? 25,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        ...(options.deduplicationId ? { deduplicationId: options.deduplicationId } : {}),
        label: options.label,
      });

      return { mode: 'qstash', url };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[QStash] Failed to enqueue ${normalizedPath}, falling back to fetch: ${message}`);
    }
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body),
  });

  return { mode: 'fetch', url };
}
