import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables before validation
dotenv.config();

const EnvSchema = z
  .object({
    PORT: z
      .string()
      .default('3000')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().positive()),
    NODE_ENV: z.enum(['development', 'production', 'test']).default(process.env.NODE_ENV as any || 'development'),
    DATABASE_URL: z
      .string()
      .default(process.env.NODE_ENV === 'test' ? (process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/newtonite_test') : '')
      .pipe(z.string().min(1, 'DATABASE_URL is required')),
    TEST_DATABASE_URL: z.string().optional(),
    // Direct/session-pooler connection (port 5432) for migrations and advisory locks.
    // DATABASE_URL should be the transaction pooler (port 6543) on Supabase/Vercel.
    DATABASE_URL_DIRECT: z.string().optional(),
    // Optional pepper mixed into the session-token hash. Sessions live in Postgres,
    // so this is defence in depth, not the primary secret.
    SESSION_SECRET: z.string().optional().default(''),
    CRON_SECRET: z.string().optional(),
    APP_ORIGIN: z.string().optional(),
    DB_POOL_MAX: z
      .string()
      .default('10')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().positive()),
    RUN_WORKER_IN_API: z
      .string()
      .default('false')
      .transform((val) => val === 'true'),
    DB_SSL_CA: z.string().optional(),
    TRUST_PROXY: z.string().default('2'),
    // Optional Google SSO via Supabase (disabled unless explicitly enabled)
    GOOGLE_LOGIN_ENABLED: z
      .string()
      .default('false')
      .transform((val) => val === 'true'),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  })
  .passthrough();

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`\n[FATAL] Invalid environment configuration:\n${errorDetails}\n`);
    throw new Error(`Environment validation failed:\n${errorDetails}`);
  }
  return result.data;
}

export const env = loadEnv();
