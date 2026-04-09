import "dotenv/config";

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

export const config = {
  port: Number(env("PORT", "4000")),
  dbPath: env("DB_PATH", "shared-orderbook.db"),

  // Rate limiting
  writeRateLimit: Number(env("WRITE_RATE_LIMIT", "60")),    // per minute per IP
  readRateLimit: Number(env("READ_RATE_LIMIT", "300")),      // per minute per IP

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS?.split(",") || ["*"]).map(s => s.trim()).filter(Boolean),

  // Webhook timeout (ms)
  webhookTimeout: Number(env("WEBHOOK_TIMEOUT", "5000")),

  // Max orders per relayer
  maxOrdersPerRelayer: Number(env("MAX_ORDERS_PER_RELAYER", "1000")),

  // Total max orders in memory
  maxOrders: Number(env("MAX_ORDERS", "50000")),
};
