-- 005_google_auth.sql
-- Add auth_provider and external_id to users table for optional Supabase Google OAuth
-- Maintain RLS and unique constraint on external_id

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local',
ADD COLUMN IF NOT EXISTS external_id VARCHAR(255) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id ON users(external_id) WHERE external_id IS NOT NULL;

-- Re-verify RLS is enabled on users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
