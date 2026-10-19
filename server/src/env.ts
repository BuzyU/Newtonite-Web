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
    SESSION_SECRET: z
      .string()
      .default(process.env.NODE_ENV === 'test' ? 'test_session_secret_at_least_32_characters_long_newtonite_secure' : '')
      .pipe(z.string().min(32, 'SESSION_SECRET must be at least 32 characters long')),
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
    GOOGLE_LOGIN_ENABLED: z
      .string()
      .default('false')
      .transform((val) => val === 'true'),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    DB_SSL_CA: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.GOOGLE_LOGIN_ENABLED) {
      if (!data.SUPABASE_URL || data.SUPABASE_URL.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_URL'],
          message: 'SUPABASE_URL is required when GOOGLE_LOGIN_ENABLED is true',
        });
      }
      if (!data.SUPABASE_PUBLISHABLE_KEY || data.SUPABASE_PUBLISHABLE_KEY.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_PUBLISHABLE_KEY'],
          message: 'SUPABASE_PUBLISHABLE_KEY is required when GOOGLE_LOGIN_ENABLED is true',
        });
      }
    }
  });

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
