ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "decisions" jsonb DEFAULT '[]'::jsonb NOT NULL;
