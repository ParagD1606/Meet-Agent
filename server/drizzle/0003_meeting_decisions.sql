ALTER TABLE "meetings" ADD COLUMN "decisions" jsonb DEFAULT '[]'::jsonb NOT NULL;
