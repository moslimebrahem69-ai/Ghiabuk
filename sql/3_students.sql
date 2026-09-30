-- =====================================================
--  منصة غيابك - ملف 3 من 7: الطلاب (students)
--  محتاج قبله: 1_teachers.sql و 2_groups.sql
--  فيه: الجدول + تسجيل حساب جديد + الدخول + تعديل البيانات (صفحة بياناتي)
--       + تحديث بيانات الطالب أول ما يفتح الموقع
--  (ممكن تشغّله أكتر من مرة، والبيانات مش بتتمسح)
-- =====================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists old_backup;

-- جدول قديم بنفس الاسم بس بشكل مختلف بيتنقل لـ old_backup (مش بيتمسح)
-- والدوال القديمة بتتمسح وتتعمل من جديد تحت
do $$
declare new_name text; f record;
begin
  if to_regclass('public.students') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'students' and column_name = 'password_hash'
  ) then
    new_name := 'students_' || to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
    execute format('alter table public.students rename to %I', new_name);
    execute format('alter table public.%I set schema old_backup', new_name);
    raise notice 'الجدول القديم students اتنقل إلى old_backup.%', new_name;
  end if;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('register_student', 'login_student', 'update_student', 'get_student',
                        'student_public', 'student_full')
  loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;

-- ---------- كود الطالب ----------
-- يبدأ من 55101 ويزيد 1 مع كل طالب: 55101 .. 55199 ثم 55200 .. 55299 وهكذا
create sequence if not exists public.student_code_seq start with 55101;
alter sequence public.student_code_seq minvalue 1;

-- ---------- الجدول ----------
create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  code          integer unique not null default nextval('public.student_code_seq'),
  full_name     text not null,
  phone         text unique not null,
  gender        text not null check (gender in ('ذكر', 'أنثى')),
  governorate   text not null,
  grade         smallint not null check (grade in (1, 2, 3)),
  track         text not null check (track in ('أدبي', 'علمي علوم', 'علمي رياضة')),
  password_hash text not null,
  created_at    timestamptz not null default now()
);
-- الطالب مالوش مجموعة ثابتة: بيحضر مع أي مجموعة في صفه
-- (لو كان فيه عمود مجموعة من نسخة قديمة بيتشال)
alter table public.students drop column if exists group_id;
-- مفتاح الجلسة: الموقع بيستخدمه يحدّث بيانات الطالب من غير ما يكتب كلمة السر كل مرة
-- (مخفي عن المدرس، وبيتغير لما الطالب يغيّر كلمة السر)
alter table public.students add column if not exists token uuid unique;

alter sequence public.student_code_seq owned by public.students.code;
-- أول طالب ياخد 55101، ولو فيه طلاب يكمل بعد آخر كود
select setval('public.student_code_seq', greatest(55100, coalesce((select max(code) from public.students), 55100)));

-- ---------- الصلاحيات ----------
-- المدرس يشوف البيانات من غير كلمة السر ومفتاح الجلسة، ويمسح
alter table public.students enable row level security;
revoke all on public.students from anon, authenticated;
grant select (id, code, full_name, phone, gender, governorate, grade, track, created_at)
  on public.students to authenticated;
grant delete on public.students to authenticated;

drop policy if exists "teacher read students"   on public.students;
drop policy if exists "teacher delete students" on public.students;
drop policy if exists "teacher all" on public.students;
create policy "teacher all" on public.students
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- ---------- بيانات الطالب اللي بترجع للموقع (من غير كلمة السر) ----------
create or replace function public.student_public(s public.students)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', s.code, 'full_name', s.full_name, 'phone', s.phone, 'gender', s.gender,
    'governorate', s.governorate, 'grade', s.grade, 'track', s.track, 'created_at', s.created_at
  );
$$;

-- بيانات الطالب + الحصص اللي حضرها + مفتاح الجلسة
-- (لو جدول الحضور لسه ما اتعملش، الحضور بيرجع فاضي بدل ما يطلع error)
create or replace function public.student_full(s public.students)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare att jsonb := '[]'::jsonb;
begin
  if to_regclass('public.attendance') is not null and to_regclass('public.sessions') is not null then
    select coalesce(jsonb_agg(jsonb_build_object('day', se.day, 'lesson_no', a.lesson_no, 'group_name', g.name)
                              order by se.day desc, a.lesson_no desc), '[]'::jsonb)
    into att
    from public.attendance a
    join public.sessions se on se.id = a.session_id
    join public.groups g on g.id = se.group_id
    where a.student_code = s.code;
  end if;
  return public.student_public(s) || jsonb_build_object('attendance', att, 'token', s.token);
end $$;

-- ---------- تسجيل طالب جديد ----------
create or replace function public.register_student(
  p_full_name text, p_phone text, p_gender text, p_governorate text,
  p_grade int, p_track text, p_password text
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s public.students;
begin
  p_full_name := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  p_phone := btrim(coalesce(p_phone, ''));
  if length(p_full_name) < 3 then raise exception 'الاسم قصير جدًا'; end if;
  if p_phone !~ '^01[0125][0-9]{8}$' then raise exception 'رقم الهاتف غير صحيح (لازم 11 رقم ويبدأ بـ 01)'; end if;
  if p_gender not in ('ذكر', 'أنثى') then raise exception 'اختار النوع'; end if;
  if coalesce(p_governorate, '') = '' then raise exception 'اختار المحافظة'; end if;
  if p_grade not in (1, 2, 3) then raise exception 'اختار الصف'; end if;
  if p_track not in ('أدبي', 'علمي علوم', 'علمي رياضة') then raise exception 'اختار الشعبة'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'كلمة السر لازم تكون 6 حروف على الأقل'; end if;

  if exists (select 1 from public.students where phone = p_phone) then
    raise exception 'رقم الهاتف ده مسجل قبل كده، اعمل تسجيل دخول';
  end if;

  insert into public.students (full_name, phone, gender, governorate, grade, track, password_hash, token)
  values (p_full_name, p_phone, p_gender, p_governorate, p_grade, p_track,
          crypt(p_password, gen_salt('bf')), gen_random_uuid())
  returning * into s;

  return public.student_full(s);
end $$;

-- ---------- تسجيل دخول الطالب (رقم الهاتف + كلمة السر) ----------
create or replace function public.login_student(p_phone text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s public.students;
begin
  select * into s from public.students where phone = btrim(coalesce(p_phone, ''));
  if not found or s.password_hash <> crypt(coalesce(p_password, ''), s.password_hash) then
    raise exception 'رقم الهاتف أو كلمة السر غلط';
  end if;
  if s.token is null then
    update public.students set token = gen_random_uuid() where id = s.id returning * into s;
  end if;
  return public.student_full(s);
end $$;

-- ---------- تحديث بيانات الطالب أول ما يفتح الموقع ----------
create or replace function public.get_student(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.students;
begin
  select * into s from public.students where token = p_token and p_token is not null;
  if not found then raise exception 'انتهت الجلسة، ادخل تاني برقم الهاتف وكلمة السر'; end if;
  return public.student_full(s);
end $$;

-- ---------- تعديل بيانات الطالب (صفحة بياناتي) ----------
-- التعديل بيتكتب في جدول الطلاب نفسه، بشرط الطالب يكتب كلمة السر الحالية
-- كود الطالب ثابت ومش بيتغير
create or replace function public.update_student(
  p_phone text,               -- رقم الهاتف الحالي
  p_password text,            -- كلمة السر الحالية
  p_full_name text,
  p_new_phone text,
  p_gender text,
  p_governorate text,
  p_grade int,
  p_track text,
  p_new_password text default null   -- فاضية = من غير تغيير
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s public.students; change_pass boolean := coalesce(p_new_password, '') <> '';
begin
  select * into s from public.students where phone = btrim(coalesce(p_phone, ''));
  if not found or s.password_hash <> crypt(coalesce(p_password, ''), s.password_hash) then
    raise exception 'كلمة السر الحالية غلط';
  end if;

  p_full_name := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  p_new_phone := btrim(coalesce(p_new_phone, ''));
  if length(p_full_name) < 3 then raise exception 'الاسم قصير جدًا'; end if;
  if p_new_phone !~ '^01[0125][0-9]{8}$' then raise exception 'رقم الهاتف غير صحيح (لازم 11 رقم ويبدأ بـ 01)'; end if;
  if p_gender not in ('ذكر', 'أنثى') then raise exception 'اختار النوع'; end if;
  if coalesce(p_governorate, '') = '' then raise exception 'اختار المحافظة'; end if;
  if p_grade not in (1, 2, 3) then raise exception 'اختار الصف'; end if;
  if p_track not in ('أدبي', 'علمي علوم', 'علمي رياضة') then raise exception 'اختار الشعبة'; end if;

  if p_new_phone <> s.phone and exists (select 1 from public.students where phone = p_new_phone) then
    raise exception 'رقم الهاتف ده مسجل لطالب تاني';
  end if;

  if change_pass and length(p_new_password) < 6 then
    raise exception 'كلمة السر الجديدة لازم تكون 6 حروف على الأقل';
  end if;

  update public.students set
    full_name     = p_full_name,
    phone         = p_new_phone,
    gender        = p_gender,
    governorate   = p_governorate,
    grade         = p_grade,
    track         = p_track,
    password_hash = case when change_pass then crypt(p_new_password, gen_salt('bf')) else password_hash end,
    -- تغيير كلمة السر بيخرّج أي جهاز تاني كان داخل بالحساب
    token         = case when change_pass or token is null then gen_random_uuid() else token end
  where id = s.id
  returning * into s;

  return public.student_full(s);
end $$;

-- ---------- الصلاحيات على الدوال ----------
revoke execute on function public.student_public(public.students) from public;
revoke execute on function public.student_full(public.students) from public;
revoke execute on function public.register_student(text, text, text, text, int, text, text) from public;
revoke execute on function public.login_student(text, text) from public;
revoke execute on function public.get_student(uuid) from public;
revoke execute on function public.update_student(text, text, text, text, text, text, int, text, text) from public;
grant execute on function public.register_student(text, text, text, text, int, text, text) to anon, authenticated;
grant execute on function public.login_student(text, text) to anon, authenticated;
grant execute on function public.get_student(uuid) to anon, authenticated;
grant execute on function public.update_student(text, text, text, text, text, text, int, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
