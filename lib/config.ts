/**
 * Environment-aware configuration
 * Centralizes all environment-specific settings
 */

// Detect deployment platform
const isNetlify = !!process.env.NETLIFY;
const isVercel = process.env.VERCEL === '1';
const isProduction = isNetlify || isVercel || process.env.NODE_ENV === 'production';

export const CONFIG = {
  redis: {
    // Connection timeout: longer in production for serverless cold starts
    connectionTimeout: isProduction ? (isNetlify ? 20000 : 30000) : 10000, // 20s Netlify, 30s Vercel, 10s dev
    // Socket-level timeout (for redis client)
    socketTimeout: isProduction ? (isNetlify ? 20000 : 30000) : 10000,
    // Retry configuration
    maxRetries: isProduction ? (isNetlify ? 2 : 3) : 1, // Fewer retries for Netlify due to timeout limits
    retryDelay: {
      base: isProduction ? (isNetlify ? 500 : 1000) : 500, // Faster retries for Netlify
      max: isProduction ? (isNetlify ? 3000 : 5000) : 2000,
    },
  },
  api: {
    // Progress endpoint timeout
    progressEndpointTimeout: isProduction ? (isNetlify ? 15000 : 20000) : 10000,
  },
  batch: {
    // Netlify Pro: 26s max function timeout
    // Processing one page at a time with optimized timeouts
    // Page timeout: 22s (includes page load + AI analysis + DB save)
    // AI analysis timeout: 15s (fits within page timeout)
    // Total per page: ~22s max, leaving 4s buffer for Netlify overhead (DB queries, function startup, etc.)
    // NOTE: Using 22s instead of 18s to reduce false failures while still fitting in 26s limit
    timeoutPerPage: isProduction && isNetlify ? 22000 : 20000, // 22s for Netlify (balanced), 20s elsewhere
    delayBetweenRequests: 500, // 500ms delay (original)
    aiAnalysisTimeout: isProduction && isNetlify ? 15000 : 20000, // 15s for Netlify (fits in 22s page timeout), 20s elsewhere
    maxRetries: 2, // 2 attempts total = 1 immediate retry
    autoRetryRounds: 1, // Retry failed pages once automatically before manual retry remains available
  },
  logging: {
    level: isProduction ? 'info' : 'debug',
  },
  platform: {
    isNetlify,
    isVercel,
    isProduction,
  },
};

