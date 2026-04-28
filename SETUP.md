```create table feather_logs (
  id          bigint generated always as identity primary key,
  author      text,
  content     text,
  channel     text,
  count       integer,
  timestamp   timestamptz default now()
);

-- Allow the anon key to insert rows (no login needed from extension)
alter table feather_logs enable row level security;

create policy "Allow anon insert"
  on feather_logs
  for insert
  to anon
  with check (true);

create policy "Allow anon select"
  on feather_logs
  for select
  to anon
  using (true);```