-- =====================================================
--  منصة غيابك - ملف 2 من 7: المجموعات (groups)
--  محتاج قبله: 1_teachers.sql
-- =====================================================

-- days: أيام الحصص (0 = الأحد، 1 = الاثنين ... 6 = السبت)
create table if not exists public.groups (
  id         bigint generated always as identity primary key,
  grade      smallint not null check (grade in (1, 2, 3)),
  name       text not null,
  start_time time not null,
  days       smallint[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- الصلاحيات ----------
alter table public.groups enable row level security;
revoke all on public.groups from anon, authenticated;
grant select on public.groups to anon, authenticated;
grant insert, update, delete on public.groups to authenticated;

-- الطالب وهو بيسجل يشوف المجموعات الشغالة بس
drop policy if exists "anyone read active groups" on public.groups;
create policy "anyone read active groups" on public.groups
  for select to anon, authenticated using (active);

-- المدرس يشوف ويضيف ويعدّل ويمسح كل المجموعات
drop policy if exists "teacher all" on public.groups;
create policy "teacher all" on public.groups
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

notify pgrst, 'reload schema';
