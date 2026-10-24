alter table meetings add column if not exists organizer_id text;
--> statement-breakpoint
alter table meetings add column if not exists source_url text;
--> statement-breakpoint
alter table meetings add column if not exists failed_reason text;
--> statement-breakpoint
alter table meeting_task_notifications add column if not exists kind text not null default 'task';
--> statement-breakpoint
alter table meeting_task_notifications add column if not exists attempts integer not null default 0;
--> statement-breakpoint
create table if not exists meeting_audit (
  id bigserial primary key,
  meeting_id text not null,
  item_id text,
  action text not null,
  actor_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index if not exists meeting_audit_meeting_idx on meeting_audit (meeting_id, created_at);
