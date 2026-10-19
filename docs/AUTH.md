# Authentication & Google OAuth Architecture

## Overview

Newtonite implements a hybrid, defense-in-depth authentication model. While day-to-day operations and automated test suites leverage secure local password hashing (Argon2id) with first-party HTTP-only session cookies, production environments can optionally enable federated **"Continue with Google"** single sign-on (SSO) via Supabase Auth.

Both authentication paths converge on the exact same server-issued, cryptographically signed HTTP-only cookie (`newtonite_session`). This ensures that the frontend application remains completely agnostic to the authentication origin and avoids storing raw bearer tokens or refresh tokens in `localStorage`.

---

## Architecture & Authentication Flow

Federated Google login is controlled by two coordinated environment flags:
- `GOOGLE_LOGIN_ENABLED` on the Node.js API server
- `VITE_GOOGLE_LOGIN_ENABLED` on the React web client

When either flag is `false` or absent, the web UI completely hides the Google login button, and the API returns `404 Not Found` for `POST /api/v1/auth/google`.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Web as React Client (/login)
    participant Supabase as Supabase Auth (OAuth)
    participant Google as Google Identity
    participant API as Newtonite API (/api/v1/auth/google)
    participant DB as PostgreSQL 16 (users table)

    User->>Web: Click "Continue with Google"
    Web->>Supabase: signInWithOAuth({ provider: 'google', redirectTo: '/auth/callback' })
    Supabase->>Google: Redirect to Google OAuth Consent
    Google->>User: Prompt consent screen
    User->>Google: Grant permissions
    Google->>Supabase: OAuth Authorization Code
    Supabase->>Web: Redirect to /auth/callback with URL hash access_token
    
    activate Web
    Web->>API: POST /api/v1/auth/google { accessToken }
    activate API
    
    API->>Supabase: GET /auth/v1/user (Headers: apikey, Bearer <token>) [5s timeout]
    Supabase-->>API: 200 OK (User JSON: id, email, email_confirmed_at, identities)
    
    API->>API: Verify provider is 'google' & email is confirmed
    API->>DB: SELECT * FROM users WHERE external_id = $1 OR lower(email) = lower($2)
    
    alt User not found in DB
        DB-->>API: Empty result
        API-->>Web: 403 Forbidden { code: 'NOT_INVITED', message: 'Ask your team admin to add you.' }
        Web->>User: Display friendly invite-only banner
    else User external_id mismatch
        DB-->>API: User found with different external_id
        API-->>Web: 403 Forbidden { code: 'EXTERNAL_ID_MISMATCH' }
    else User authorized
        DB-->>API: Matching user record
        opt First Google Login
            API->>DB: UPDATE users SET auth_provider = 'google', external_id = $1 WHERE id = $2
        end
        API-->>Web: 200 OK (Set-Cookie: newtonite_session=...; HttpOnly; SameSite=Lax; Secure)
        deactivate API
        Web->>Supabase: supabase.auth.signOut({ scope: 'local' })
        Web->>Web: Redirect to /attention
    end
    deactivate Web
```

---

## Architectural Decision: Why Supabase Auth over Firebase Auth

| Criterion | Supabase Auth | Firebase Auth | Newtonite Decision Rationale |
| :--- | :--- | :--- | :--- |
| **Ecosystem Synergy** | PostgreSQL Native | Google Cloud Proprietary | Newtonite's core database is PostgreSQL 16 with Row-Level Security (RLS). Supabase aligns directly with Postgres primitives. |
| **Server Token Verification** | Standard REST API (`/auth/v1/user`) with publishable anon key | Heavy `firebase-admin` SDK requiring service account JSON keys | Supabase requires only an HTTP `GET` with public key and timeout. No service account private keys need to be stored or managed on Render. |
| **Client Bundle Size** | Minimal `@supabase/supabase-js` (~45 KB gzip) | Modular Firebase SDK (~90+ KB gzip) | Zero runtime overhead when `VITE_GOOGLE_LOGIN_ENABLED` is false. Clean OAuth handoff. |
| **Local Storage Hygiene** | Clean local purge via `signOut({ scope: 'local' })` | Firebase persists token and refresh token in IndexedDB by default | Newtonite forbids storing long-lived credentials in client browser storage. Supabase allows immediate client-side token discard. |
| **Single-Vendor Footprint** | Consolidated with database hosting | Introduces third external cloud vendor | Simplifies compliance, latency profiling, and operations under pressure. |

---

## Security & Threat Model

### 1. Invite-Only Access Control (Preventing Open Account Creation)
- **Threat:** Any Google user worldwide signs in with their personal Google account, gaining unauthorized access to company operations.
- **Mitigation:** The Newtonite API **never** auto-provisions user accounts or team memberships upon successful Google OAuth. The user's verified email is strictly matched against pre-existing rows in the `users` table created by team administrators. If no matching email exists, the API halts and returns `403 Forbidden` (`NOT_INVITED`).

### 2. Email Verification & Takeover Resistance
- **Threat:** An attacker registers a Google account with an unverified or alias email belonging to an executive, attempting to hijack the corporate session.
- **Mitigation:** The API inspects the Supabase user payload and requires both:
  - `user.email_confirmed_at` to be a non-empty timestamp.
  - The identity provider to be explicitly `'google'`.
  Unconfirmed emails are immediately rejected with `403 Forbidden` (`UNVERIFIED_EMAIL`).

### 3. External ID Binding & Account Swapping Defense
- **Threat:** A malicious actor attempts to link an existing corporate email to a secondary Google account ID.
- **Mitigation:** On initial login, the user's immutable Google subject ID (`supabase_user.id`) is stored in `users.external_id`. On subsequent logins, lookups query `external_id` first. If a record matches by email but has a differing non-null `external_id`, the request is rejected with `403 Forbidden` (`EXTERNAL_ID_MISMATCH`).

### 4. Zero Secrets in Client or Logs
- **Threat:** Leakage of database or auth service keys in client bundles or log aggregators.
- **Mitigation:**
  - Neither the frontend nor the backend ever reads or requires `SUPABASE_SERVICE_ROLE_KEY`.
  - Only the public anon key (`SUPABASE_PUBLISHABLE_KEY`) is used for the `/auth/v1/user` validation endpoint.
  - Client-side Supabase client is initialized with `persistSession: false` and `autoRefreshToken: false`.

### 5. Rate Limiting & Denial-of-Service Defense
- **Threat:** Automated botnets flood `POST /api/v1/auth/google` to exhaust network sockets or trigger Supabase API throttling.
- **Mitigation:** The route is protected by `authRateLimiter`, capping login attempts per IP address with standard `429 Too Many Requests` responses.
