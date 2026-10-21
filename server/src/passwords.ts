import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing: argon2id (the @node-rs/argon2 default algorithm) with
 * OWASP-recommended parameters (19 MiB memory, 2 iterations, 1 lane).
 */
const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

// Hash of a random string, used to equalise login timing for unknown accounts.
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing-equalisation');
  return dummyHashPromise;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// A short deny-list of the most common passwords that still satisfy the length rule.
const COMMON_PASSWORDS = new Set(
  [
    'password1234', 'password12345', 'passw0rd1234', '123456789012', '1234567890123',
    'qwertyuiop12', 'qwerty123456', 'iloveyou1234', 'administrator', 'letmein123456',
    'welcome12345', 'changeme1234', 'newtonite1234', 'newtonite12345', 'password123!',
    'abcdef123456', 'trustno1trustno1', 'admin1234567', 'admin12345678',
  ].map((p) => p.toLowerCase())
);

export interface PasswordContext {
  email?: string;
  name?: string;
}

/** Returns an error message, or null when the password is acceptable. */
export function validatePasswordPolicy(password: unknown, ctx: PasswordContext = {}): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`;
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'That password is too common. Choose something less guessable.';
  }
  if (ctx.email) {
    const local = ctx.email.toLowerCase().split('@')[0];
    if (lower === ctx.email.toLowerCase() || (local.length >= 6 && lower === local)) {
      return 'Password must not be the same as your email address.';
    }
  }
  if (ctx.name && lower === ctx.name.trim().toLowerCase()) {
    return 'Password must not be the same as your name.';
  }
  return null;
}
