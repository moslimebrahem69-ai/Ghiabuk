-- =====================================================
--  منصة غيابك - ملف 1 من 7: المدرسين (teachers)
--  شغّل الملفات بالترتيب من 1 لـ 7 في: Supabase > SQL Editor > Run
--
--  حساب المدرس:
--    الإيميل:     teacher@ghiyabak.com
--    كلمة السر:  ghiabuk2026
--
--  مساعد المدرس: اعمله حساب من Authentication > Users > Add user
--  وبعدين ضيف الإيميل بتاعه:
--    insert into public.teachers (email) values ('assistant@example.com');
-- =====================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists old_backup;

-- جدول قديم بنفس الاسم بس بشكل مختلف بيتنقل لـ old_backup (مش بيتمسح)
do $$
declare new_name text; f record;
begin
  if to_regclass('public.teachers') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'teachers' and column_name = 'email'
  ) then
    new_name := 'teachers_' || to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
    execute format('alter table public.teachers rename to %I', new_name);
    execute format('alter table public.%I set schema old_backup', new_name);
    raise notice 'الجدول القديم teachers اتنقل إلى old_backup.%', new_name;
  end if;

  -- دالة is_teacher قديمة بشكل مختلف
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_teacher'
      and (pg_get_function_identity_arguments(p.oid) <> '' or p.prorettype <> 'boolean'::regtype)
  loop
    execute 'drop function ' || f.sig || ' cascade';
  end loop;
end $$;

-- ---------- الجدول ----------
create table if not exists public.teachers (
  email text primary key
);

alter table public.teachers enable row level security;
revoke all on public.teachers from anon, authenticated;

-- ---------- هل المستخدم الحالي مدرس؟ (بتستخدمها كل الجداول التانية) ----------
create or replace function public.is_teacher()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.teachers
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------- حساب المدرس ----------
-- لو الحساب موجود قبل كده، كلمة السر بس هي اللي بتتحدث
do $$
declare
  v_email text := 'teacher@ghiyabak.com';
  v_pass  text := 'ghiabuk2026';
  v_id    uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(v_email);

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_pass, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{"name":"المدرس"}', now(), now(),
      '', '', '', '', '', ''
    );
    insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now()
    );
  else
    update auth.users
    set encrypted_password = extensions.crypt(v_pass, extensions.gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
    where id = v_id;
  end if;

  insert into public.teachers (email) values (v_email) on conflict (email) do nothing;
end $$;

notify pgrst, 'reload schema';
