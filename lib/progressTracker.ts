/**
 * Progress Tracker
 * Manages audit progress and ETA calculations
 */

import { CONFIG } from './config';

export interface AuditProgress {
  jobId: string;
  status: 'discovering' | 'auditing' | 'aggregating' | 'completed' | 'failed';
  totalPages: number;
  completedPages: number;
  currentPage?: string;
  percentage: number;
  estimatedTimeLeft: number; // in seconds
  startTime: number;
  pageResults: Array<{
    url: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    score?: number;
    startTime?: number; // When page audit started
    endTime?: number; // When page audit completed
    duration?: number; // Duration in milliseconds
  }>;
  // Enhanced timing data for better estimation
  averagePageDuration?: number; // Average time per page in milliseconds
  recentPageDurations?: number[]; // Last 5 page durations for trend analysis
  autoRetryRoundsCompleted?: number;
}

// In-memory storage for progress (in production, use Redis or database)
// Using a global Map to ensure persistence across requests in dev mode
// NOTE: In serverless environments (Vercel), this will be cleared between requests
// For production, use Redis or a database
// Using globalThis to ensure the Map persists across hot reloads in Next.js dev mode
const globalForProgressStore = globalThis as unknown as {
  progressStore: Map<string, AuditProgress> | undefined;
};

if (!globalForProgressStore.progressStore) {
  globalForProgressStore.progressStore = new Map<string, AuditProgress>();
  console.log('📦 Initialized global progressStore');
}

const progressStore = globalForProgressStore.progressStore;

// Check if we're in Vercel production environment
const isVercelProduction = process.env.VERCEL === '1' && process.env.NODE_ENV === 'production';

// Database client (uses Neon PostgreSQL via NETLIFY_DATABASE_URL, or Redis via REDIS_URL)
let kv: any = null;
let useKv = false;
let kvInitialized = false;
let useNeon = false;

// Lazy initialization function - only called when needed
async function initializeKv() {
  if (kvInitialized) {
    return;
  }

  // Skip initialization during build time or static generation
  // But allow initialization at runtime even if RUNTIME is not set (serverless execution)
  if (typeof window === 'undefined') {
    // Check if we're in build phase
    const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build' ||
      process.env.NEXT_PHASE === 'phase-development-build';

    // Skip initialization during build phase (unless in Netlify/Vercel where functions need it)
    // Netlify and Vercel serverless functions need database access even during build
    if (isBuildPhase && !process.env.VERCEL && !process.env.NETLIFY) {
      console.log('⚠️ Skipping KV initialization during build/static generation');
      kvInitialized = true;
      return;
    }

    // If we're in Vercel or Netlify, always allow initialization (serverless functions need it)
    if (process.env.VERCEL || process.env.NETLIFY) {
      // This is fine - continue with initialization
    }
  }

  try {
    // First, try Neon PostgreSQL (NETLIFY_DATABASE_URL) - preferred for Netlify
    if (process.env.NETLIFY_DATABASE_URL) {
      console.log('🔍 Attempting to initialize Neon PostgreSQL connection...');
      console.log('   NETLIFY_DATABASE_URL present:', !!process.env.NETLIFY_DATABASE_URL);
      
      try {
        const { dbGet, dbSet, dbDel, dbKeys, dbSavePageResult, dbGetPageResult, dbGetAllPageResults } = await import('./neonAdapter');
        
        // Create compatible interface for Neon
        kv = {
          async get(key: string) {
            return await dbGet(key);
          },
          async set(key: string, value: string, options?: { ex?: number }) {
            return await dbSet(key, value, options);
          },
          async del(key: string) {
            return await dbDel(key);
          },
          async keys(pattern: string) {
            return await dbKeys(pattern);
          },
          // Neon-specific methods
          async savePageResult(jobId: string, url: string, result: any) {
            return await dbSavePageResult(jobId, url, result);
          },
          async getPageResult(jobId: string, url: string) {
            return await dbGetPageResult(jobId, url);
          },
          async getAllPageResults(jobId: string) {
            return await dbGetAllPageResults(jobId);
          }
        };
        
        useKv = true;
        useNeon = true;
        kvInitialized = true;
        console.log('✅ Neon PostgreSQL connection initialized');
        console.log('   Using NETLIFY_DATABASE_URL for persistent storage');
        return;
      } catch (neonError: any) {
        console.error('❌ Failed to initialize Neon:', neonError.message);
        console.error('   Will try Redis fallback if available');
        // Continue to Redis fallback
      }
    }
    
    // Fallback to Redis Labs connection string (REDIS_URL)
    if (process.env.REDIS_URL) {
      console.log('🔍 Attempting to initialize Redis Labs connection...');
      console.log('   REDIS_URL present:', !!process.env.REDIS_URL);
      console.log('   REDIS_URL length:', process.env.REDIS_URL?.length);
      console.log('   REDIS_URL starts with redis://:', process.env.REDIS_URL?.startsWith('redis://'));

      try {
        // Use official redis package as per Vercel's guide
        const { createClient } = require('redis');

        // Create Redis client (following Vercel's pattern)
        const redis = createClient({
          url: process.env.REDIS_URL,
          socket: {
            connectTimeout: CONFIG.redis.socketTimeout, // Environment-aware timeout
            reconnectStrategy: (retries: number) => {
              if (retries > 3) {
                console.error(`⚠️ Redis reconnection failed after ${retries} attempts`);
                return false; // Stop retrying
              }
              const delay = Math.min(retries * 50, 2000); // Exponential backoff
              console.log(`   Redis reconnect attempt ${retries}, waiting ${delay}ms...`);
              return delay;
            }
          }
        });

        // Add error handlers for better debugging
        redis.on('error', (err: any) => {
          console.error('❌ Redis connection error:', err.message);
          console.error('   Error code:', err.code);
          console.error('   Error stack:', err.stack);
        });

        redis.on('connect', () => {
          console.log('✅ Redis connection established');
        });

        redis.on('ready', () => {
          console.log('✅ Redis is ready to accept commands');
        });

        // Connect lazily on first use
        let connected = false;
        let connectionAttempted = false;
        let connectionError: Error | null = null;

        async function ensureConnected() {
          // If already connected, return immediately
          if (connected && redis.isOpen && redis.isReady) {
            return;
          }

          // Exponential backoff retry logic for serverless environments
          let attempt = 0;
          const maxRetries = CONFIG.redis.maxRetries;
          const baseDelay = CONFIG.redis.retryDelay.base;
          const maxDelay = CONFIG.redis.retryDelay.max;
          const connectionTimeout = CONFIG.redis.connectionTimeout;

          while (attempt < maxRetries) {
            try {
              console.log(`🔌 Attempting Redis connection (attempt ${attempt + 1}/${maxRetries})...`);
              console.log(`   Timeout: ${connectionTimeout / 1000}s`);
              console.log('   REDIS_URL present:', !!process.env.REDIS_URL);

              // Connect using Vercel's pattern: await createClient().connect()
              // Set environment-aware connection timeout
              const connectPromise = redis.connect();
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Redis connection timeout after ${connectionTimeout / 1000} seconds`)), connectionTimeout)
              );

              await Promise.race([connectPromise, timeoutPromise]);
              connected = true;
              connectionAttempted = true;
              connectionError = null;
              console.log('✅ Redis connected successfully');

              // Test connection with a ping
              try {
                const pingResult = await redis.ping();
                console.log('✅ Redis ping successful:', pingResult);
              } catch (pingError: any) {
                console.warn('⚠️ Redis ping failed, but connection seems OK:', pingError.message);
              }
              
              return; // Success - exit retry loop
            } catch (err: any) {
              attempt++;
              connectionError = err;
              connected = false;
              console.error(`❌ Redis connection attempt ${attempt} failed:`, err.message);
              console.error('   Error code:', err.code);
              console.error('   Error name:', err.name);

              // If this isn't the last attempt, wait before retrying
              if (attempt < maxRetries) {
                const delay = Math.min(
                  baseDelay * Math.pow(2, attempt - 1), // Exponential backoff: 1s, 2s, 4s
                  maxDelay
                );
                console.log(`⚠️ Retrying Redis connection in ${delay}ms... (${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
              } else {
                console.error('❌ Redis connection failed after all retry attempts');
                console.error('   Full error:', err);
              }
            }
          }

          // If still not connected after all retries, throw error in production
          const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
          if (isProduction && connectionError) {
            throw new Error(`Redis connection failed after ${maxRetries} attempts: ${connectionError.message}`);
          }
          
          // In development, allow fallback to in-memory storage
          if (!isProduction) {
            console.warn('⚠️ Redis connection failed - falling back to in-memory storage (dev only)');
          }
          if (!connected && connectionAttempted) {
            throw connectionError || new Error('Redis connection failed');
          }
        }

        // Create a compatible interface for Redis operations
        kv = {
          async get(key: string) {
            await ensureConnected();
            const result = await redis.get(key);
            return result;
          },
          async set(key: string, value: string, options?: { ex?: number }) {
            await ensureConnected();
            if (options?.ex) {
              // Redis SETEX: set with expiration in seconds
              return await redis.setEx(key, options.ex, value);
            }
            return await redis.set(key, value);
          },
          async del(key: string) {
            await ensureConnected();
            return await redis.del(key);
          },
          async keys(pattern: string) {
            await ensureConnected();
            return await redis.keys(pattern);
          }
        };
        useKv = true;
        kvInitialized = true;
        console.log('✅ Redis Labs connection initialized (lazy connect enabled)');
        console.log('   Connection will be established on first use');
        console.log('   Using REDIS_URL for persistent storage');
        return;
      } catch (redisError: any) {
        console.error('❌ Failed to initialize Redis:', redisError.message);
        console.error('   Error code:', redisError.code);
        console.error('   Error name:', redisError.name);
        console.error('   Will fall back to in-memory storage');
        kvInitialized = true; // Mark as initialized to prevent retries
        return;
      }
    }

    // Enhanced production validation with better error handling
    const isProduction = process.env.VERCEL === '1' || process.env.NETLIFY === 'true' || process.env.NODE_ENV === 'production';
    const hasNeonUrl = !!process.env.NETLIFY_DATABASE_URL;
    const hasRedisUrl = !!process.env.REDIS_URL;
    const hasStorage = hasNeonUrl || hasRedisUrl;

    if (isProduction) {
      if (!hasStorage) {
        console.error('❌ CRITICAL: No database storage configured in production!');
        console.error('   This will cause progress tracking to fail.');
        if (process.env.NETLIFY === 'true') {
          console.error('   Please set NETLIFY_DATABASE_URL (link Neon database in Netlify Dashboard)');
          console.error('   → Go to Netlify Dashboard → Data → Neon → Create/Link Database');
        } else {
          console.error('   Please set REDIS_URL or NETLIFY_DATABASE_URL environment variable');
          console.error('   → Go to Dashboard → Settings → Environment Variables');
          console.error('   → Add REDIS_URL with your Redis Labs connection string');
          console.error('   Example: redis://default:password@host:port');
        }
        console.error('   Progress tracking will NOT persist across serverless invocations without storage');
        // Don't throw during initialization - let it fail gracefully when actually trying to use storage
        // This prevents app crashes during build/startup
      } else {
        if (hasNeonUrl) {
          console.log('✅ NETLIFY_DATABASE_URL is configured for production (Neon PostgreSQL)');
        } else {
          console.log('✅ REDIS_URL is configured for production');
          console.log(`   Connection timeout: ${CONFIG.redis.connectionTimeout / 1000} seconds`);
          console.log(`   Retry attempts: ${CONFIG.redis.maxRetries} with exponential backoff`);
        }
      }
    } else {
      console.log(`${hasStorage ? '✅' : '⚠️'} Storage ${hasStorage ? 'configured' : 'not configured'} in development`);
      if (hasNeonUrl) {
        console.log('   Using Neon PostgreSQL (NETLIFY_DATABASE_URL)');
      } else if (hasRedisUrl) {
        console.log('   Using Redis (REDIS_URL)');
      } else {
        console.log('   Progress tracking will use in-memory storage (may not persist in serverless)');
      }
    }
    kvInitialized = true;
  } catch (e: any) {
    console.log('⚠️ Failed to initialize Redis/KV:', e.message || e);
    console.log('   Will use in-memory storage (may not persist in serverless)');
    kvInitialized = true; // Mark as initialized to prevent retries
  }
}

// Export store reference for debugging
export function getProgressStoreSize(): number {
  return progressStore.size;
}

// Debug function to log store state
export async function debugProgressStore(): Promise<void> {
  // Initialize KV lazily if not already done
  await initializeKv();

  if (useKv && kv) {
    const allKeys = await kv.keys('audit:progress:*') as string[];
    console.log('📊 Progress Store Debug (KV):');
    console.log('   Total jobs:', allKeys.length);
    console.log('   Job IDs:', allKeys.map((k: string) => k.replace('audit:progress:', '')));
    for (const key of allKeys) {
      const jobId = key.replace('audit:progress:', '');
      const progress = await getProgress(jobId);
      if (progress) {
        console.log(`   - ${jobId}: ${progress.status} (${progress.completedPages}/${progress.totalPages})`);
      }
    }
  } else {
    console.log('📊 Progress Store Debug (in-memory):');
    console.log('   Total jobs:', progressStore.size);
    console.log('   Job IDs:', Array.from(progressStore.keys()));
    progressStore.forEach((progress, jobId) => {
      console.log(`   - ${jobId}: ${progress.status} (${progress.completedPages}/${progress.totalPages})`);
    });
  }
}

/**
 * Creates a new progress tracker
 */
export async function createProgressTracker(jobId: string, totalPages: number): Promise<AuditProgress> {
  const progress: AuditProgress = {
    jobId,
    status: 'discovering',
    totalPages,
    completedPages: 0,
    percentage: 0,
    estimatedTimeLeft: 0,
    startTime: Date.now(),
    pageResults: [],
  };

  // In serverless environments, KV is required for persistence
  // If KV is not available, we should still try to store in memory
  // but warn that it may not persist across invocations

  // Store in memory (for dev/local)
  progressStore.set(jobId, progress);

  // CRITICAL: Store in KV if available (required for serverless persistence)
  if (useKv && kv) {
    try {
      const kvKey = `audit:progress:${jobId}`;
      const progressJson = JSON.stringify(progress);

      console.log(`📝 Storing progress in KV: ${jobId}`);
      console.log(`   KV key: ${kvKey}`);
      console.log(`   Data size: ${progressJson.length} bytes`);

      // Reduced expiration to 30 minutes (from 1 hour) to free up memory faster
      await kv.set(kvKey, progressJson, { ex: 1800 }); // Expire after 30 minutes
      console.log(`✅ Stored progress in KV: ${jobId}`);

      // Verify it was saved by reading it back
      try {
        const verifyData = await kv.get(kvKey) as string | null;
        if (verifyData) {
          console.log(`✅ Verified progress saved to KV: ${jobId} (${verifyData.length} bytes)`);
        } else {
          console.error(`❌ CRITICAL: Progress not found in KV after save: ${jobId}`);
          console.error(`   This indicates a Redis write issue`);
        }
      } catch (verifyError: any) {
        console.error(`⚠️ Failed to verify KV save:`, verifyError.message);
        // Continue anyway - the save might have succeeded
      }
    } catch (kvError: any) {
      console.error('❌ Failed to store in KV:', kvError.message);
      console.error('   Error code:', kvError.code);
      console.error('   Error name:', kvError.name);
      console.error('   Error stack:', kvError.stack);
      // Even if KV fails, continue with in-memory storage for dev
      console.warn('⚠️ Progress will only be available in current instance (not persistent in serverless)');
    }
  } else {
    // Check if we're in production without Redis/KV
    const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    if (isProduction) {
      const hasRedisUrl = !!process.env.REDIS_URL;

      if (!hasRedisUrl) {
        console.error('❌ CRITICAL: REDIS_URL is not configured in production!');
        console.error('   Progress will NOT persist across serverless invocations');
        console.error('   Please set REDIS_URL environment variable in Vercel');
        console.error('   → Go to Vercel Dashboard → Settings → Environment Variables');
        console.error('   → Add REDIS_URL with your Redis Labs connection string');
      } else {
        console.log('⚠️ REDIS_URL is set but Redis connection not initialized yet');
        console.log('   Connection will be established on first use');
      }
    }
  }

  console.log(`📝 Created progress tracker: ${jobId}, totalPages: ${totalPages}`);
  console.log(`📝 Progress store size: ${progressStore.size}`);
  console.log(`📝 Store keys: ${Array.from(progressStore.keys()).join(', ')}`);
  console.log(`📝 KV enabled: ${useKv && kv ? 'YES' : 'NO'}`);

  // Verify it was stored
  const stored = progressStore.get(jobId);
  if (!stored) {
    console.error(`❌ CRITICAL: Job ${jobId} was not stored in progressStore!`);
  } else {
    console.log(`✅ Verified job ${jobId} is in store`);
  }

  return progress;
}

/**
 * Updates progress for a specific page
 */
export async function updatePageProgress(
  jobId: string,
  pageUrl: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  score?: number
): Promise<void> {
  // Initialize KV lazily if not already done
  await initializeKv();

  // Get progress (checking both memory and KV)
  let progress = progressStore.get(jobId);
  if (!progress && useKv && kv) {
    try {
      const kvData = await kv.get(`audit:progress:${jobId}`) as string | null;
      if (kvData) {
        const parsed = JSON.parse(kvData) as AuditProgress;
        progress = parsed;
        progressStore.set(jobId, parsed);
      }
    } catch (e) {
      // Ignore KV errors
    }
  }
  if (!progress) return;

  const pageIndex = progress.pageResults.findIndex(p => p.url === pageUrl);
  const now = Date.now();

  if (pageIndex >= 0) {
    const pageResult = progress.pageResults[pageIndex];
    const previousStatus = pageResult.status;

    // Track timing
    if (status === 'processing' && previousStatus !== 'processing') {
      // Page just started processing
      pageResult.startTime = now;
    } else if ((status === 'completed' || status === 'failed') && previousStatus === 'processing') {
      // Page just finished
      pageResult.endTime = now;
      if (pageResult.startTime) {
        pageResult.duration = now - pageResult.startTime;

        // Update timing statistics for better estimation
        if (status === 'completed' && pageResult.duration) {
          // Track recent durations (last 5 completed pages)
          if (!progress.recentPageDurations) {
            progress.recentPageDurations = [];
          }
          progress.recentPageDurations.push(pageResult.duration);

          // Keep only last 5 durations
          if (progress.recentPageDurations.length > 5) {
            progress.recentPageDurations.shift();
          }

          // Calculate average duration
          const completedPages = progress.pageResults.filter(p => p.status === 'completed' && p.duration);
          if (completedPages.length > 0) {
            const totalDuration = completedPages.reduce((sum, p) => sum + (p.duration || 0), 0);
            progress.averagePageDuration = totalDuration / completedPages.length;
          }
        }
      }
    }

    pageResult.status = status;
    if (score !== undefined) {
      pageResult.score = score;
    }
  } else {
    // New page
    const newPageResult: any = { url: pageUrl, status, score };
    if (status === 'processing') {
      newPageResult.startTime = now;
    }
    progress.pageResults.push(newPageResult);
  }

  // Update completed count
  progress.completedPages = progress.pageResults.filter(p => p.status === 'completed').length;
  progress.percentage = Math.round((progress.completedPages / progress.totalPages) * 100);

  // Calculate estimated time left with improved algorithm
  const remainingPages = progress.totalPages - progress.completedPages;

  if (remainingPages > 0 && progress.completedPages > 0) {
    // Use recent durations if available (more accurate for trend)
    let estimatedMsPerPage: number;

    if (progress.recentPageDurations && progress.recentPageDurations.length >= 2) {
      // Use weighted average: recent pages weighted more heavily
      const recentAvg = progress.recentPageDurations.reduce((sum, d) => sum + d, 0) / progress.recentPageDurations.length;
      const overallAvg = progress.averagePageDuration || recentAvg;

      // Weight: 70% recent average, 30% overall average
      estimatedMsPerPage = (recentAvg * 0.7) + (overallAvg * 0.3);
    } else if (progress.averagePageDuration) {
      // Use overall average if available
      estimatedMsPerPage = progress.averagePageDuration;
    } else {
      // Fallback: use elapsed time average
      const elapsed = Date.now() - progress.startTime;
      estimatedMsPerPage = elapsed / progress.completedPages;
    }

    // Add buffer for processing overhead (10%)
    estimatedMsPerPage = estimatedMsPerPage * 1.1;

    // Calculate estimated time left
    progress.estimatedTimeLeft = Math.round((estimatedMsPerPage * remainingPages) / 1000); // Convert to seconds
  } else {
    progress.estimatedTimeLeft = 0;
  }

  progressStore.set(jobId, progress);
  
  // CRITICAL: Save to KV to persist 'processing' status for progress API
  console.log(`💾 Saving page progress update: ${pageUrl} -> ${status}`);
  console.log(`   JobId: ${jobId}`);
  console.log(`   Page index: ${pageIndex >= 0 ? pageIndex : 'new page'}`);
  await saveProgressToKv(jobId, progress);
  
  // Verify the save was successful
  if (useKv && kv) {
    try {
      const verifyKey = `audit:progress:${jobId}`;
      const verifyData = await kv.get(verifyKey) as string | null;
      if (verifyData) {
        const verifyProgress = JSON.parse(verifyData) as AuditProgress;
        const verifyPageStatus = verifyProgress.pageResults.find(p => p.url === pageUrl)?.status;
        console.log(`✅ Verified save: ${pageUrl} status in ${useNeon ? 'Neon' : 'KV'} is: ${verifyPageStatus}`);
        if (verifyPageStatus !== status) {
          console.error(`❌ STATUS MISMATCH: Expected ${status}, but found ${verifyPageStatus}`);
        }
      }
    } catch (verifyError: any) {
      console.warn(`⚠️ Failed to verify save: ${verifyError.message}`);
    }
  }
}

/**
 * Saves progress to KV (helper function to ensure persistence)
 */
async function saveProgressToKv(jobId: string, progress: AuditProgress): Promise<void> {
  if (useKv && kv) {
    try {
      const kvKey = `audit:progress:${jobId}`;
      
      // OPTIMIZATION: Remove finalResult from progress if it contains screenshots
      // Store finalResult separately or exclude screenshots to save memory
      const progressToStore = { ...progress };
      const finalResult = (progressToStore as any).finalResult;
      if (finalResult && finalResult.pageResults) {
        // Remove screenshots from finalResult pageResults to save memory
        const optimizedFinalResult = {
          ...finalResult,
          pageResults: finalResult.pageResults.map((page: any) => {
            const { screenshot, ...pageWithoutScreenshot } = page;
            return pageWithoutScreenshot;
          })
        };
        (progressToStore as any).finalResult = optimizedFinalResult;
      }
      
      const progressJson = JSON.stringify(progressToStore);
      const sizeKB = Math.round(progressJson.length / 1024);
      
      // Reduced expiration to 30 minutes for progress (from 1 hour) to free up memory faster
      await kv.set(kvKey, progressJson, { ex: 1800 });
      console.log(`📝 Saved progress to KV: ${jobId} (status: ${progress.status}, size: ${sizeKB}KB)`);

      // Verify it was saved
      try {
        const verifyData = await kv.get(kvKey) as string | null;
        if (verifyData) {
          const verifyProgress = JSON.parse(verifyData);
          const hasFinalResult = !!(verifyProgress as any).finalResult;
          console.log(`✅ Verified progress saved to KV: ${jobId}, has finalResult: ${hasFinalResult}`);
        }
      } catch (verifyError: any) {
        console.warn(`⚠️ Failed to verify KV save:`, verifyError.message);
      }
    } catch (kvError: any) {
      // Handle Redis OOM (Out of Memory) errors specifically
      if (kvError.message && (kvError.message.includes('OOM') || kvError.message.includes('maxmemory'))) {
        console.error('❌ Redis OOM: Failed to save progress to KV (Redis out of memory)');
        console.error('   Consider: 1) Upgrading Redis plan, 2) Cleaning old data, 3) Reducing data size');
        console.error('   Progress saved in memory only - may not persist across serverless invocations');
      } else {
        console.error('⚠️ Failed to save progress to KV:', kvError.message);
        console.error('   Progress saved in memory only - may not persist across serverless invocations');
      }
    }
  }
}

/**
 * Updates overall status
 */
export async function updateStatus(jobId: string, status: AuditProgress['status'], currentPage?: string): Promise<void> {
  // Initialize KV lazily if not already done
  await initializeKv();

  // Get progress (checking both memory and KV)
  // CRITICAL: Check memory first to preserve any finalResult that was just set
  let progress = progressStore.get(jobId);
  if (!progress && useKv && kv) {
    try {
      const kvData = await kv.get(`audit:progress:${jobId}`) as string | null;
      if (kvData) {
        const parsedProgress = JSON.parse(kvData) as AuditProgress;
        if (parsedProgress) {
          progress = parsedProgress;
          progressStore.set(jobId, progress);
        }
      }
    } catch (e) {
      // Ignore KV errors
      console.error('⚠️ Failed to get progress from KV in updateStatus:', e);
    }
  }

  // If still no progress, create a minimal one (shouldn't happen, but safety check)
  if (!progress) {
    console.warn(`⚠️ Progress not found for jobId ${jobId} in updateStatus, creating minimal progress`);
    progress = {
      jobId,
      status,
      totalPages: 1,
      completedPages: 0,
      percentage: 0,
      estimatedTimeLeft: 0,
      startTime: Date.now(),
      pageResults: [],
    };
  }

  // Preserve finalResult if it exists (don't overwrite it)
  const existingFinalResult = (progress as any).finalResult;

  progress.status = status;
  if (currentPage) {
    progress.currentPage = currentPage;
  }

  // Restore finalResult if it existed
  if (existingFinalResult) {
    (progress as any).finalResult = existingFinalResult;
  }

  // Update in memory FIRST (immediate)
  progressStore.set(jobId, progress);

  // Also update in KV if available (persistent storage)
  await saveProgressToKv(jobId, progress);

  // Log warning if KV is not available in production
  if (!useKv || !kv) {
    const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    if (isProduction) {
      console.warn(`⚠️ KV not available - status update saved in memory only for ${jobId}`);
    }
  }
}

/**
 * Updates automatic retry metadata for a job
 */
export async function updateAutoRetryRounds(jobId: string, roundsCompleted: number): Promise<void> {
  await initializeKv();

  let progress = progressStore.get(jobId);
  if (!progress && useKv && kv) {
    try {
      const kvData = await kv.get(`audit:progress:${jobId}`) as string | null;
      if (kvData) {
        progress = JSON.parse(kvData) as AuditProgress;
      }
    } catch (e) {
      console.error('⚠️ Failed to get progress from KV in updateAutoRetryRounds:', e);
    }
  }

  if (!progress) {
    console.warn(`⚠️ Progress not found for jobId ${jobId} in updateAutoRetryRounds`);
    return;
  }

  progress.autoRetryRoundsCompleted = roundsCompleted;
  progressStore.set(jobId, progress);
  await saveProgressToKv(jobId, progress);
}

/**
 * Saves final result to progress tracker
 * This ensures finalResult is persisted to KV
 */
export async function saveFinalResult(jobId: string, finalResult: any): Promise<void> {
  await initializeKv();

  // Get current progress
  let progress = progressStore.get(jobId);
  if (!progress && useKv && kv) {
    try {
      const kvData = await kv.get(`audit:progress:${jobId}`) as string | null;
      if (kvData) {
        progress = JSON.parse(kvData) as AuditProgress;
        progressStore.set(jobId, progress);
      }
    } catch (e) {
      console.error('⚠️ Failed to get progress from KV in saveFinalResult:', e);
    }
  }

  if (!progress) {
    console.error(`❌ Cannot save finalResult - progress not found for jobId: ${jobId}`);
    return;
  }

  const isSinglePageResult =
    !!finalResult &&
    Array.isArray(finalResult.findings) &&
    !!finalResult.summary;

  const isFullSiteResult =
    !!finalResult &&
    (
      finalResult.aggregated !== undefined ||
      Array.isArray(finalResult.sortedPages) ||
      Array.isArray(finalResult.pageResults)
    );

  let optimizedFinalResult: any;

  if (isSinglePageResult) {
    // Preserve single-page shape expected by the UI.
    const { screenshot, html, ...singleWithoutLargeData } = finalResult;
    optimizedFinalResult = {
      ...singleWithoutLargeData,
      findings: finalResult.findings.slice(0, 25),
    };
  } else if (isFullSiteResult) {
    // CRITICAL OPTIMIZATION: Strip screenshots and reduce data size to prevent Redis OOM
    optimizedFinalResult = {
      aggregated: finalResult.aggregated ? {
        ...finalResult.aggregated,
        // Remove screenshots and limit findings from aggregated pageResults
        pageResults: finalResult.aggregated.pageResults?.map((page: any) => {
          const { screenshot, html, ...pageWithoutLargeData } = page;
          return {
            ...pageWithoutLargeData,
            findings: page.findings?.slice(0, 20) || [] // Limit to 20 findings per page
          };
        }) || []
      } : finalResult.aggregated,
      
      sortedPages: finalResult.sortedPages?.map((page: any) => {
        // Remove full result object, keep only summary
        const { result, ...pageSummary } = page;
        if (result) {
          const { screenshot, html, ...resultWithoutLargeData } = result;
          return {
            ...pageSummary,
            result: {
              ...resultWithoutLargeData,
              findings: result.findings?.slice(0, 10) || [] // Limit findings
            }
          };
        }
        return pageSummary;
      }) || [],
      
      // Limit pageResults size - remove screenshots and limit findings
      pageResults: finalResult.pageResults?.map((page: any) => {
        const { screenshot, html, ...pageWithoutLargeData } = page;
        return {
          ...pageWithoutLargeData,
          findings: page.findings?.slice(0, 10) || [] // Limit to 10 findings
        };
      }) || [],
      
      failedPages: finalResult.failedPages || []
    };
  } else {
    // Keep unexpected/error payloads as-is so polling can display error details.
    optimizedFinalResult = finalResult;
  }

  // Calculate size before saving
  const resultJson = JSON.stringify(optimizedFinalResult);
  const sizeKB = Math.round(resultJson.length / 1024);
  console.log(`💾 Saving optimized finalResult (${sizeKB}KB) for jobId: ${jobId}`);

  // Set finalResult
  (progress as any).finalResult = optimizedFinalResult;
  progress.status = 'completed';

  // Save to memory first
  progressStore.set(jobId, progress);

  // Save to KV with OOM handling
  try {
    await saveProgressToKv(jobId, progress);
    console.log(`✅ Final result saved successfully (${sizeKB}KB)`);
  } catch (kvError: any) {
    // Handle Redis OOM specifically
    if (kvError.message && (kvError.message.includes('OOM') || kvError.message.includes('maxmemory'))) {
      console.error(`❌ Redis OOM: Cannot save finalResult (${sizeKB}KB)`);
      console.error(`   Attempting cleanup before retry...`);
      
      // Try cleanup and retry once
      try {
        await cleanupOldRedisData();
        await saveProgressToKv(jobId, progress);
        console.log(`✅ Final result saved after cleanup`);
      } catch (retryError: any) {
        console.error(`❌ Still OOM after cleanup. Job marked as completed in memory only.`);
        console.error(`   Please clear Redis manually or upgrade plan`);
        // Still mark as completed so UI doesn't hang
        progress.status = 'completed';
        progressStore.set(jobId, progress);
      }
    } else {
      throw kvError;
    }
  }
}

/**
 * Gets current progress
 */
export async function getProgress(jobId: string): Promise<AuditProgress | null> {
  // Initialize KV lazily if not already done
  await initializeKv();

  // Clean up jobId: remove any "progress:" prefix and trim whitespace
  const cleanJobId = jobId.trim().replace(/^progress:/, '');
  if (cleanJobId !== jobId) {
    console.log(`⚠️ Cleaned jobId: "${jobId}" -> "${cleanJobId}"`);
  }

  console.log(`🔍 Getting progress for jobId: ${cleanJobId}`);
  console.log(`🔍 Progress store size: ${progressStore.size}`);
  console.log(`🔍 All jobIds in store: ${Array.from(progressStore.keys()).join(', ')}`);

  // CRITICAL FIX: In production/serverless (Netlify), always fetch from Neon/KV first
  // Memory cache is empty across function invocations in serverless environments
  const isProduction = process.env.NETLIFY === 'true' || process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  
  let progress: AuditProgress | null = null;

  // Always check KV/Neon first in production, or if KV is available
  if (useKv && kv) {
    try {
      console.log(`🔍 Checking ${useNeon ? 'Neon' : 'KV'} for jobId: ${cleanJobId}`);
      const kvKey = `audit:progress:${cleanJobId}`;
      console.log(`   KV key: ${kvKey}`);
      const kvData = await kv.get(kvKey) as string | null;
      if (kvData) {
        console.log(`✅ Found progress in ${useNeon ? 'Neon' : 'KV'}: ${cleanJobId}`);
        console.log(`   Data length: ${kvData.length} bytes`);
        const kvProgress = JSON.parse(kvData) as AuditProgress;
        // Update memory cache with fresh data
        progressStore.set(cleanJobId, kvProgress);
        progress = kvProgress;
      } else {
        console.log(`❌ No data found in ${useNeon ? 'Neon' : 'KV'} for key: ${kvKey}`);
        // Try to list all keys to see what's available
        try {
          const allKeys = await kv.keys('audit:*') as string[];
          console.log(`   Available keys (${allKeys.length}):`, allKeys.slice(0, 10));
        } catch (listError: any) {
          console.error('   Failed to list keys:', listError.message);
        }
      }
    } catch (kvError: any) {
      console.error(`❌ Failed to get from ${useNeon ? 'Neon' : 'KV'}:`, kvError.message);
      console.error('   Error code:', kvError.code);
      console.error('   Error name:', kvError.name);
      console.error('   Error stack:', kvError.stack);
    }
  }

  // Fallback to memory only in dev mode (not production)
  if (!progress && !isProduction) {
    const memoryProgress = progressStore.get(cleanJobId);
    if (memoryProgress) {
      progress = memoryProgress;
      console.log(`✅ Found progress in memory: ${cleanJobId}`);
    }
  }

  if (!progress) {
    console.log(`❌ Progress not found for jobId: ${cleanJobId}`);
    console.log(`   Available jobIds: ${Array.from(progressStore.keys()).join(', ')}`);
    console.log(`   JobId match check: ${Array.from(progressStore.keys()).map(k => `"${k}" === "${cleanJobId}": ${k === cleanJobId}`).join(', ')}`);
    return null;
  }
  
  console.log(`✅ Found progress for jobId: ${cleanJobId}, status: ${progress.status}`);
  console.log(`   Page results: ${progress.pageResults.length} pages`);
  console.log(`   Statuses: ${progress.pageResults.map(p => `${p.url}:${p.status}`).join(', ')}`);
  return progress;
}

/**
 * Gets all active jobs (for debugging)
 */
export async function getAllJobs(): Promise<string[]> {
  // Initialize KV lazily if not already done
  await initializeKv();

  if (useKv && kv) {
    try {
      const keys = await kv.keys('audit:progress:*') as string[];
      console.log(`[getAllJobs] Found ${keys.length} keys in KV matching 'audit:progress:*'`);
      console.log(`[getAllJobs] Keys:`, keys.slice(0, 10));

      // Extract jobId from keys like "audit:progress:jobId"
      const jobIds = keys
        .map((key: string) => key.replace('audit:progress:', ''))
        .filter((id: string) => id.length > 0); // Filter out empty strings

      console.log(`[getAllJobs] Extracted ${jobIds.length} job IDs:`, jobIds.slice(0, 10));
      return jobIds;
    } catch (error: any) {
      console.error('[getAllJobs] Failed to get keys from KV:', error.message);
      console.error('[getAllJobs] Error:', error);
      // Fallback to in-memory store
      return Array.from(progressStore.keys());
    }
  } else {
    console.log(`[getAllJobs] KV not available, using in-memory store (${progressStore.size} jobs)`);
    return Array.from(progressStore.keys());
  }
}

/**
 * Formats estimated time left as human-readable string
 */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Cleans up old progress data (older than 1 hour)
 */
export function cleanupOldProgress(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, progress] of progressStore.entries()) {
    if (progress.startTime < oneHourAgo && progress.status === 'completed') {
      progressStore.delete(jobId);
    }
  }
}

/**
 * Cleans up old Redis data to free memory
 * Removes completed jobs older than 30 minutes and their associated results
 */
export async function cleanupOldRedisData(): Promise<void> {
  await initializeKv();
  
  if (!useKv || !kv) {
    console.log(`[cleanupOldRedisData] ${useNeon ? 'Neon' : 'Redis'} not available, skipping cleanup`);
    return;
  }
  
  // Use Neon cleanup if available (more efficient)
  if (useNeon) {
    try {
      const { dbCleanup } = await import('./neonAdapter');
      const deleted = await dbCleanup();
      console.log(`[cleanupOldRedisData] ✅ Cleaned up ${deleted} expired records from Neon`);
      return;
    } catch (error: any) {
      console.error(`[cleanupOldRedisData] ❌ Neon cleanup error:`, error.message);
      return;
    }
  }

  // Redis cleanup pattern
  try {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const allProgressKeys = await kv.keys('audit:progress:*') as string[];
    let cleanedCount = 0;

    for (const key of allProgressKeys) {
      try {
        const data = await kv.get(key) as string | null;
        if (data) {
          const progress = JSON.parse(data) as AuditProgress;
          // Clean up completed jobs older than 30 minutes
          if (progress.status === 'completed' && progress.startTime < thirtyMinutesAgo) {
            await kv.del(key);
            cleanedCount++;

            // Also clean up associated page results
            const jobId = key.replace('audit:progress:', '');
            const resultKeys = await kv.keys(`audit:result:${jobId}:*`) as string[];
            for (const resultKey of resultKeys) {
              await kv.del(resultKey);
            }
            console.log(`[cleanupOldRedisData] Cleaned up job: ${jobId} (${resultKeys.length} results)`);
          }
        }
      } catch (e: any) {
        console.warn(`[cleanupOldRedisData] Failed to process key ${key}:`, e.message);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[cleanupOldRedisData] ✅ Cleaned up ${cleanedCount} old jobs from Redis`);
    } else {
      console.log(`[cleanupOldRedisData] No old jobs to clean up`);
    }
  } catch (error: any) {
    console.error(`[cleanupOldRedisData] ❌ Cleanup error:`, error.message);
  }
}



/**
 * Saves a full audit result for a specific page to KV
 * This allows us to aggregate results later without keeping everything in memory
 * OPTIMIZATION: Excludes screenshots to save Redis memory (screenshots are large base64 strings)
 */
export async function savePageResult(jobId: string, url: string, result: any): Promise<void> {
  await initializeKv();

  if (useKv && kv) {
    try {
      // OPTIMIZATION: Remove screenshot to save storage (screenshots can be 100KB-2MB+)
      // Screenshots are only needed for display, not for aggregation
      const resultWithoutScreenshot = { ...result };
      const screenshotSize = resultWithoutScreenshot.screenshot ? resultWithoutScreenshot.screenshot.length : 0;
      delete resultWithoutScreenshot.screenshot;
      
      const resultJson = JSON.stringify(resultWithoutScreenshot);
      const sizeKB = Math.round(resultJson.length / 1024);
      
      // Use Neon-specific method if available, otherwise fall back to Redis pattern
      if (useNeon && kv.savePageResult) {
        await kv.savePageResult(jobId, url, resultWithoutScreenshot);
      } else {
        // Redis pattern: Create a unique key for this page result
        const safeUrl = Buffer.from(url).toString('base64');
        const kvKey = `audit:result:${jobId}:${safeUrl}`;
        // Reduced expiration to 1 hour (from 2 hours) to free up memory faster
        await kv.set(kvKey, resultJson, { ex: 3600 }); // Keep for 1 hour
      }
      
      if (screenshotSize > 0) {
        const screenshotSizeKB = Math.round(screenshotSize / 1024);
        console.log(`✅ Saved page result to ${useNeon ? 'Neon' : 'KV'}: ${jobId} / ${url} (${sizeKB}KB, excluded ${screenshotSizeKB}KB screenshot)`);
      } else {
        console.log(`✅ Saved page result to ${useNeon ? 'Neon' : 'KV'}: ${jobId} / ${url} (${sizeKB}KB)`);
      }
    } catch (e: any) {
      // Handle Redis OOM (Out of Memory) errors specifically
      if (e.message && (e.message.includes('OOM') || e.message.includes('maxmemory'))) {
        console.error(`❌ Redis OOM: Failed to save page result to KV (Redis out of memory)`);
        console.error(`   Consider: 1) Upgrading Redis plan, 2) Cleaning old data, 3) Reducing data size`);
        console.error(`   Job will continue but results may not persist across invocations`);
      } else {
        console.error(`❌ Failed to save page result to ${useNeon ? 'Neon' : 'KV'}: ${e.message}`);
      }
    }
  } else {
    // Fallback? Ideally we'd store in a Map, but for serverless we really need KV.
    // We can store it attached to the progress object in memory for local dev.
    const progress = progressStore.get(jobId);
    if (progress) {
      if (!(progress as any)._fullResults) (progress as any)._fullResults = {};
      (progress as any)._fullResults[url] = result;
      console.log(`✅ Saved page result to memory (dev mode): ${jobId} / ${url}`);
    }
  }
}

/**
 * Retrieves a full audit result for a specific page
 */
export async function getPageResult(jobId: string, url: string): Promise<any | null> {
  await initializeKv();

  if (useKv && kv) {
    try {
      // Use Neon-specific method if available, otherwise fall back to Redis pattern
      if (useNeon && kv.getPageResult) {
        return await kv.getPageResult(jobId, url);
      } else {
        // Redis pattern
        const safeUrl = Buffer.from(url).toString('base64');
        const kvKey = `audit:result:${jobId}:${safeUrl}`;
        const data = await kv.get(kvKey) as string | null;

        if (data) {
          return JSON.parse(data);
        }
      }
    } catch (e: any) {
      console.error(`❌ Failed to get page result from ${useNeon ? 'Neon' : 'KV'}: ${e.message}`);
    }
  } else {
    // Check in-memory fallback
    const progress = progressStore.get(jobId);
    if (progress && (progress as any)._fullResults) {
      return (progress as any)._fullResults[url] || null;
    }
  }
  return null;
}

/**
 * Retrieves all available page results for a job
 */
export async function getAllPageResults(jobId: string): Promise<any[]> {
  await initializeKv();
  
  // Use Neon-specific method if available for better performance
  if (useKv && kv && useNeon && kv.getAllPageResults) {
    try {
      const results = await kv.getAllPageResults(jobId);
      console.log(`✅ Retrieved ${results.length} page results from Neon`);
      return results;
    } catch (e: any) {
      console.error(`❌ Failed to get all page results from Neon: ${e.message}`);
      // Fall through to Redis pattern
    }
  }
  
  // Redis pattern: Fetch individually
  const results: any[] = [];
  const progress = await getProgress(jobId);
  if (!progress) return [];

  console.log(`🔍 Fetching full results for ${progress.completedPages} completed pages...`);

  // Get all completed URLs
  const completedUrls = progress.pageResults
    .filter(p => p.status === 'completed')
    .map(p => p.url);

  // Fetch each one
  // In a real production app we might optimize this with mget if available, or parallel fetch
  for (const url of completedUrls) {
    const result = await getPageResult(jobId, url);
    if (result) {
      results.push(result);
    } else {
      console.warn(`⚠️ Result missing for completed page: ${url}`);
    }
  }

  return results;
}
