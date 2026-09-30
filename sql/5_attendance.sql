-- =====================================================
--  منصة غيابك - ملف 5 من 7: الحضور (attendance)
--  محتاج قبله: 1_teachers.sql و 3_students.sql و 4_sessions.sql
--
--  الطالب مالوش مجموعة ثابتة: بيحضر مع أي مجموعة في صفه
--  وبيتسجل مرة واحدة بس في كل حصة (رقم الحصة)
-- =====================================================

create schema if not exists old_backup;

-- جدول حضور قديم (بالتاريخ بس) بيتنقل لـ old_backup (مش بيتمسح)
do $$
declare new_name text; f record;
begin
  if to_regclass('public.attendance') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attendance' and column_name = 'session_id'
  ) then
    new_name := 'attendance_' || to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
    execute format('alter table public.attendance rename to %I', new_name);
    execute format('alter table public.%I set schema old_backup', new_name);
    raise notice 'الجدول القديم attendance اتنقل إلى old_backup.%', new_name;
  end if;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_attendance'
  loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;

-- ---------- الجدول ----------
create table if not exists public.attendance (
  id           bigint generated always as identity primary key,
  session_id   bigint not null references public.sessions(id) on delete cascade,
  student_code integer not null references public.students(code) on delete cascade,
  grade        smallint not null,
  lesson_no    integer not null,
  scanned_at   timestamptz not null default now(),
  unique (student_code, grade, lesson_no)
);

-- ---------- الصلاحيات ----------
-- التسجيل بيتم من خلال الدالة mark_attendance بس، والمدرس يقدر يشوف ويلغي
alter table public.attendance enable row level security;
revoke all on public.attendance from anon, authenticated;
grant select, delete on public.attendance to authenticated;

drop policy if exists "teacher read attendance"   on public.attendance;
drop policy if exists "teacher delete attendance" on public.attendance;
drop policy if exists "teacher all" on public.attendance;
create policy "teacher all" on public.attendance
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- ---------- تسجيل حضور طالب في حصة (بالكود من الـ QR) ----------
create or replace function public.mark_attendance(p_session_id bigint, p_code int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  se public.sessions;
  s public.students;
  n int;
  prev_group text;
begin
  if not public.is_teacher() then raise exception 'غير مصرح لك'; end if;

  select * into se from public.sessions where id = p_session_id;
  if not found then raise exception 'الحصة مش موجودة'; end if;
  if se.closed_at is not null then raise exception 'الحصة دي اتقفلت، ابدأها تاني'; end if;

  select * into s from public.students where code = p_code;
  if not found then raise exception 'مفيش طالب بالكود %', p_code; end if;
  if s.grade <> se.grade then
    raise exception '% في الصف % الثانوي، مش في صف الحصة دي',
      s.full_name, (array['الأول', 'الثاني', 'الثالث'])[s.grade];
  end if;

  insert into public.attendance (session_id, student_code, grade, lesson_no)
  values (se.id, s.code, se.grade, se.lesson_no)
  on conflict (student_code, grade, lesson_no) do nothing;
  get diagnostics n = row_count;

  if n = 0 then
    select g.name into prev_group
    from public.attendance a
    join public.sessions x on x.id = a.session_id
    join public.groups g on g.id = x.group_id
    where a.student_code = s.code and a.grade = se.grade and a.lesson_no = se.lesson_no;
  end if;

  return public.student_public(s) || jsonb_build_object(
    'already', n = 0,
    'already_group', prev_group
  );
end $$;

revoke execute on function public.mark_attendance(bigint, int) from public;
grant execute on function public.mark_attendance(bigint, int) to authenticated;

notify pgrst, 'reload schema';
