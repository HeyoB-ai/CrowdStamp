-- Trigger: maak automatisch een profiel aan zodra een auth-gebruiker wordt aangemaakt.
-- Kolommen komen overeen met de profiles-tabel zoals gebruikt in de Netlify-functies
-- (invite-member.js / signup.js): id, email, role, company_id, full_name, functie, status.
--
-- role-CHECK staat alleen 'superuser', 'admin', 'worker' toe -> coalesce-default 'worker' is veilig.
-- functie is leeg/NULL voor admins (uit signup), of een van: medewerker, onderaannemer, service_monteur.
--
-- DRAAI DIT HANDMATIG in de Supabase SQL Editor (niet automatisch uitgevoerd).

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role, company_id, full_name, functie, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'worker'),
    (new.raw_user_meta_data->>'company_id')::uuid,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'functie',
    'invited'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
