import { env } from './env.js';

export interface SupabaseUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
  user_metadata?: {
    email_verified?: boolean;
    email?: string;
  };
}

export interface TokenValidator {
  validate(accessToken: string): Promise<SupabaseUser>;
}

export class HttpSupabaseTokenValidator implements TokenValidator {
  constructor(
    private supabaseUrl: string,
    private publishableKey: string
  ) {}

  async validate(accessToken: string): Promise<SupabaseUser> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const url = `${this.supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          apikey: this.publishableKey,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const error = new Error(`Token validation failed: ${response.status} ${errorText}`);
        (error as any).status = response.status;
        throw error;
      }

      const user = (await response.json()) as SupabaseUser;
      return user;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Global validator singleton with test injection support
let activeValidator: TokenValidator | null = null;

export function getTokenValidator(): TokenValidator {
  if (activeValidator) {
    return activeValidator;
  }
  return new HttpSupabaseTokenValidator(
    env.SUPABASE_URL || '',
    env.SUPABASE_PUBLISHABLE_KEY || ''
  );
}

export function setTokenValidator(validator: TokenValidator | null): void {
  activeValidator = validator;
}
