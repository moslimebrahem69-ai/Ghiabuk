-- =====================================================
--  منصة غيابك - ملف 6 من 7: إعدادات الصفوف (grade_settings)
--  محتاج قبله: 1_teachers.sql
--
--  لكل صف: سعر الفترة وعدد الحصص في الفترة
--  مثال: 400 جنيه لكل 12 حصة → سعر الحصة = 400 ÷ 12
-- =====================================================

-- ---------- الجدول ----------
create table if not exists public.grade_settings (
  grade         smallint primary key check (grade in (1, 2, 3)),
  price         numeric(10, 2) not null default 0,
  lessons_count integer not null default 12 check (lessons_count > 0)
);

-- صف لكل سنة دراسية
insert into public.grade_settings (grade) values (1), (2), (3) on conflict do nothing;

-- ---------- الصلاحيات ----------
alter table public.grade_settings enable row level security;
revoke all on public.grade_settings from anon, authenticated;
grant select, insert, update on public.grade_settings to authenticated;

drop policy if exists "teacher all" on public.grade_settings;
create policy "teacher all" on public.grade_settings
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

notify pgrst, 'reload schema';
