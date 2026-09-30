-- =====================================================
--  منصة غيابك - ملف 4 من 7: الحصص (sessions)
--  محتاج قبله: 1_teachers.sql و 2_groups.sql
-- =====================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'start_session'
  loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;

-- ---------- الجدول ----------
create table if not exists public.sessions (
  id         bigint generated always as identity primary key,
  grade      smallint not null check (grade in (1, 2, 3)),
  group_id   bigint not null references public.groups(id) on delete restrict,
  lesson_no  integer not null check (lesson_no > 0),
  day        date not null default (now() at time zone 'Africa/Cairo')::date,
  started_at timestamptz not null default now(),
  closed_at  timestamptz,
  unique (group_id, lesson_no)
);

-- ---------- الصلاحيات ----------
alter table public.sessions enable row level security;
revoke all on public.sessions from anon, authenticated;
grant select, insert, update, delete on public.sessions to authenticated;

drop policy if exists "teacher all" on public.sessions;
create policy "teacher all" on public.sessions
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- ---------- بدء حصة جديدة مع القواعد الصارمة ----------
create or replace function public.start_session(p_group_id bigint, p_lesson_no int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare 
  g public.groups; 
  s public.sessions;
  active_session_count int;
begin
  if not public.is_teacher() then raise exception 'غير مصرح لك'; end if;
  select * into g from public.groups where id = p_group_id;
  if not found then raise exception 'المجموعة مش موجودة'; end if;
  if coalesce(p_lesson_no, 0) < 1 then raise exception 'رقم الحصة غلط'; end if;

  -- 1. التأكد من عدم وجود أي حصة جارية حالياً (مفتوحة من أي أدمن)
  select count(*) into active_session_count from public.sessions where closed_at is null;
  if active_session_count > 0 then
    raise exception 'توجد حصة جارية بالفعل حالياً! يجب إنهاء الحصة المفتوحة أولاً قبل بدء حصة جديدة.';
  end if;

  -- 2. التأكد من عدم تكرار رقم الحصة لنفس المجموعة
  select * into s from public.sessions where group_id = g.id and lesson_no = p_lesson_no;
  if found then
    raise exception 'تم إنشاء وتأكيد الحصة رقم % لهذه المجموعة من قبل!', p_lesson_no;
  end if;

  -- 3. إنشاء الحصة الجديدة
  insert into public.sessions (grade, group_id, lesson_no) values (g.grade, g.id, p_lesson_no)
  returning * into s;
  
  return to_jsonb(s) || jsonb_build_object('resumed', false);
end $$;

revoke execute on function public.start_session(bigint, int) from public;
grant execute on function public.start_session(bigint, int) to authenticated;

notify pgrst, 'reload schema';