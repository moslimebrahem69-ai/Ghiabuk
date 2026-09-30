-- =====================================================
--  منصة غيابك - ملف 7 من 7: المدفوعات (payments)
--  محتاج قبله: 1_teachers.sql و 3_students.sql
--
--  period_no رقم الفترة: الفترة 1 = الحصص 1..12، الفترة 2 = الحصص 13..24 وهكذا
--  (حسب عدد الحصص في grade_settings)
-- =====================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'confirm_payment'
  loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;

-- ---------- الجدول ----------
create table if not exists public.payments (
  id           bigint generated always as identity primary key,
  student_code integer not null references public.students(code) on delete cascade,
  grade        smallint not null,
  period_no    integer not null check (period_no > 0),
  amount       numeric(10, 2) not null default 0,
  paid_at      timestamptz not null default now(),
  paid_by      text,
  unique (student_code, grade, period_no)
);

-- ---------- الصلاحيات ----------
-- تأكيد الدفع بيتم من خلال الدالة confirm_payment، والمدرس يقدر يشوف ويلغي
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
grant select, delete on public.payments to authenticated;

drop policy if exists "teacher all" on public.payments;
create policy "teacher all" on public.payments
  for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- ---------- تأكيد الدفع (بيحفظ التاريخ والوقت ومين أكد) ----------
create or replace function public.confirm_payment(p_code int, p_grade int, p_period int, p_amount numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.payments;
begin
  if not public.is_teacher() then raise exception 'غير مصرح لك'; end if;
  insert into public.payments (student_code, grade, period_no, amount, paid_by)
  values (p_code, p_grade, p_period, coalesce(p_amount, 0), auth.jwt() ->> 'email')
  on conflict (student_code, grade, period_no)
  do update set amount = excluded.amount, paid_at = now(), paid_by = excluded.paid_by
  returning * into p;
  return to_jsonb(p);
end $$;

revoke execute on function public.confirm_payment(int, int, int, numeric) from public;
grant execute on function public.confirm_payment(int, int, int, numeric) to authenticated;

notify pgrst, 'reload schema';
