-- 口播流量預測系統（vp_）＋ 帳號點數 ＋ 個人/基礎模型
-- 規格見 docs：發布前預測（模式A文稿/模式B影片）→ 發布後回填校準

-- ── 帳號與點數 ──
create table if not exists public.vp_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  points int not null default 60,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.vp_accounts enable row level security;

-- security definer helper，避免 RLS 自我遞迴
create or replace function public.vp_is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select is_admin from public.vp_accounts where user_id = auth.uid()), false)
$$;

drop policy if exists "vp_accounts select" on public.vp_accounts;
create policy "vp_accounts select" on public.vp_accounts
  for select using (user_id = auth.uid() or public.vp_is_admin());
drop policy if exists "vp_accounts insert self" on public.vp_accounts;
create policy "vp_accounts insert self" on public.vp_accounts
  for insert with check (user_id = auth.uid() and points <= 60 and is_admin = false);
drop policy if exists "vp_accounts admin update" on public.vp_accounts;
create policy "vp_accounts admin update" on public.vp_accounts
  for update using (public.vp_is_admin()) with check (public.vp_is_admin());

-- 點數扣抵：每次 AI 計算呼叫一次（原子性，不足即失敗）
create or replace function public.vp_spend_points(cost int default 10) returns int
language plpgsql security definer set search_path = public as $$
declare remaining int;
begin
  update public.vp_accounts set points = points - cost
   where user_id = auth.uid() and is_active and points >= cost
   returning points into remaining;
  if remaining is null then
    raise exception 'INSUFFICIENT_POINTS';
  end if;
  return remaining;
end $$;
revoke all on function public.vp_spend_points(int) from public;
grant execute on function public.vp_spend_points(int) to authenticated;

-- ── 主檔：一支影片/一篇文稿一筆 ──
create table if not exists public.vp_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text default 'ig',
  title text,
  script_raw text,
  video_name text,
  duration_sec int,
  status text default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 模式A：文稿分析 ──
create table if not exists public.vp_script_analysis (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.vp_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hook_score numeric,
  overall_script_score numeric,
  sentences jsonb,
  emotion_arc jsonb,
  predicted_drop_points jsonb,
  suggestions jsonb,
  model text,
  analyzed_at timestamptz not null default now()
);

-- ── 模式B：影片/節奏分析 ──
create table if not exists public.vp_visual_scores (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.vp_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  virality_score numeric,
  hook_strength numeric,
  attention_curve jsonb,
  drop_points jsonb,
  tool text,
  scored_at timestamptz not null default now()
);

-- ── 各階段預估＋校準落差（校準鏈核心）──
create table if not exists public.vp_predictions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.vp_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage text not null,           -- A_script / B_visual
  predicted_score numeric,
  fusion_result jsonb,
  actual_score numeric,
  error numeric,
  calibrated_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── 發布後真實流量（截圖 vision 判讀）──
create table if not exists public.vp_actuals (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.vp_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text default 'ig',
  views int, reach int, likes int, comments int, shares int, saves int,
  avg_watch_sec numeric,
  retention_curve jsonb,
  raw jsonb,
  fetched_at timestamptz not null default now()
);

-- ── 個人模型：每個帳號自己的校準，互不干擾 ──
create table if not exists public.vp_user_models (
  user_id uuid primary key references auth.users(id) on delete cascade,
  model jsonb not null default '{"bias":0,"samples":0,"notes":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── 基礎模型：全體共用（原系統設計 + 管理員交叉比對寫入的共通洞察）──
create table if not exists public.vp_base_model (
  id int primary key check (id = 1),
  model jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- per-user 資料表 RLS（own only；admin 可讀供交叉比對）
do $$
declare t text;
begin
  foreach t in array array['vp_posts','vp_script_analysis','vp_visual_scores','vp_predictions','vp_actuals','vp_user_models'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format('create policy "admin read" on public.%I for select using (public.vp_is_admin())', t);
  end loop;
end $$;

alter table public.vp_base_model enable row level security;
drop policy if exists "base model read" on public.vp_base_model;
create policy "base model read" on public.vp_base_model
  for select using (auth.role() = 'authenticated');
drop policy if exists "base model admin write" on public.vp_base_model;
create policy "base model admin write" on public.vp_base_model
  for update using (public.vp_is_admin()) with check (public.vp_is_admin());

create index if not exists vp_posts_user_idx on public.vp_posts (user_id, created_at desc);
create index if not exists vp_predictions_post_idx on public.vp_predictions (post_id);
create index if not exists vp_actuals_post_idx on public.vp_actuals (post_id);

-- 基礎模型種子：原系統設計的評分邏輯
insert into public.vp_base_model (id, model) values (1, '{
  "version": 1,
  "principles": [
    "2026 IG 演算法權重：觀看時長 > DM > 分享 > 收藏 > 按讚",
    "前 3 秒 Hook 決定留存：問題式/否定反向/具體數字/好奇心/對比/衝擊型開場最有效",
    "開場句 15-20 字內效果最佳，超過 35 字會被閱讀更多截斷",
    "結構：開頭鉤子 → 問題 → 解法 → CTA，約 60 秒、語速 150 字/分",
    "口語化短句優於書面長句；具體數字與親身經歷提升可信度",
    "九宮格交叉法：身份接觸事物 × 受眾煩惱 = 高共鳴 Hook"
  ],
  "common_insights": []
}'::jsonb)
on conflict (id) do nothing;

-- 既有使用者補發帳號（60 點），管理員 = poting75321@gmail.com
insert into public.vp_accounts (user_id, email, points, is_admin)
select id, email, 60, (email = 'poting75321@gmail.com') from auth.users
on conflict (user_id) do nothing;
update public.vp_accounts set is_admin = true where email = 'poting75321@gmail.com';
