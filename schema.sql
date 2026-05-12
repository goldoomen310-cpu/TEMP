-- AniView Supabase Schema
-- Run this in your Supabase SQL Editor to create the required tables.

-- ─── Users table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── Episode comments table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS episode_comments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anime_id VARCHAR(100) NOT NULL,
    episode_number VARCHAR(10) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_anime_episode ON episode_comments(anime_id, episode_number);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON episode_comments(created_at DESC);

-- Add parent_id for replies (nullable, references top-level comment)
ALTER TABLE episode_comments ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES episode_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON episode_comments(parent_id);

-- ─── Comment likes table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_likes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    comment_id UUID NOT NULL REFERENCES episode_comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_like BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_comment ON comment_likes(comment_id);

-- ─── Watch progress table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS watch_progress (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anime_id VARCHAR(100) NOT NULL,
    mal_id VARCHAR(100),
    title TEXT NOT NULL,
    poster TEXT,
    episode_number VARCHAR(10) NOT NULL,
    current_time DOUBLE PRECISION DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, anime_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_progress(user_id, updated_at DESC);

-- ─── Row Level Security (optional but recommended) ─────────
-- These policies restrict access so the service_role key is needed
-- for server-side writes, but public can read comments.

ALTER TABLE episode_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Anyone can read comments
CREATE POLICY "Comments are public for reading"
    ON episode_comments FOR SELECT
    USING (true);

-- Only authenticated users can insert their own comments
CREATE POLICY "Users can insert their own comments"
    ON episode_comments FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can read their own data
CREATE POLICY "Users can read own data"
    ON users FOR SELECT
    USING (auth.uid() = id);

-- Note: The server uses the service_role key which bypasses RLS.
-- RLS policies above are optional safeguards if you ever expose
-- the anon key to the frontend (not recommended for this app).
