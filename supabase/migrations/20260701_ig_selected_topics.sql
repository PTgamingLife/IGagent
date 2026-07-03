-- 已選主題紀錄：記錄使用者點開過的每日主題（每個 hook 一筆，最新在前）
create table if not exists public.ig_selected_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hook text,
  theme text,
  style text,
  format text,
  selected_at timestamptz not null default now()
);
create index if not exists ig_selected_topics_user_idx
  on public.ig_selected_topics (user_id, selected_at desc);

alter table public.ig_selected_topics enable row level security;
drop policy if exists "own selected topics" on public.ig_selected_topics;
create policy "own selected topics" on public.ig_selected_topics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
