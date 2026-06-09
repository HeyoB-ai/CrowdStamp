-- ============================================================================
-- VOORSTEL RLS-POLICIES VOOR MODEL B  —  NIET BLIND TOEPASSEN
-- ============================================================================
--
-- ⚠️  LEES DIT EERST. Een fout hier is een DATALEK tussen bedrijven.
--
--  - Dit bestand wordt NIET automatisch uitgevoerd.
--  - De `enable row level security`-regels staan BEWUST uitgecommentarieerd.
--    Zet RLS pas AAN nadat je de policies per tabel hebt gereviewd én getest met
--    minstens drie testaccounts: (1) een gewone Model A-medewerker, (2) een
--    opdrachtgever-admin, (3) een onderaannemer-admin die voor die opdrachtgever werkt.
--  - Zet RLS per tabel apart aan en controleer na ELKE tabel of de app nog werkt
--    (login, check-in, urenstaat, medewerkers, onderaannemers).
--  - Let op: de Netlify-functies gebruiken de SERVICE ROLE key en omzeilen RLS.
--    De browser gebruikt de ANON key + JWT en valt WÉL onder RLS.
--
-- Leesregel (kern): een gebruiker mag een registratie zien als
--   registrations.company_id = zijn company   (Model A, eigen bedrijf)
--   OF registrations.client_company_id = zijn company via een ACTIEVE relatie (Model B).
-- ============================================================================


-- ── Helperfuncties (SECURITY DEFINER → omzeilen RLS, voorkomen recursie) ──

-- Company van de huidige ingelogde gebruiker.
create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select company_id from public.profiles where id = auth.uid()
$$;

-- Bestaat er een actieve relatie waarin p_client de opdrachtgever van p_contractor is?
create or replace function public.has_active_relationship(p_client uuid, p_contractor uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_relationships
    where client_company_id = p_client
      and contractor_company_id = p_contractor
      and status = 'active'
  )
$$;


-- ── registrations ──────────────────────────────────────────────────────────
-- SELECT: eigen company (Model A) OF opdrachtgever via actieve relatie (Model B).
drop policy if exists registrations_select on public.registrations;
create policy registrations_select on public.registrations
for select using (
  company_id = public.current_company_id()
  or (
    client_company_id = public.current_company_id()
    and public.has_active_relationship(public.current_company_id(), company_id)
  )
);

-- INSERT: alleen binnen je eigen company en op je eigen user_id.
drop policy if exists registrations_insert on public.registrations;
create policy registrations_insert on public.registrations
for insert with check (
  company_id = public.current_company_id()
  and user_id = auth.uid()
);

-- UPDATE: alleen je eigen registraties binnen je eigen company.
-- LET OP: admins die andermans rijen moeten kunnen corrigeren vallen hier NIET onder.
-- Breid deze policy uit met een admin-check als dat nodig is.
drop policy if exists registrations_update on public.registrations;
create policy registrations_update on public.registrations
for update using (
  company_id = public.current_company_id()
  and user_id = auth.uid()
) with check (
  company_id = public.current_company_id()
  and user_id = auth.uid()
);


-- ── company_relationships ──────────────────────────────────────────────────
-- SELECT: relaties waarin jouw company aan een van beide kanten staat.
-- (Aanmaken/wijzigen gebeurt via engage-contractor met de service role → geen insert-policy nodig.)
drop policy if exists company_relationships_select on public.company_relationships;
create policy company_relationships_select on public.company_relationships
for select using (
  client_company_id = public.current_company_id()
  or contractor_company_id = public.current_company_id()
);


-- ── companies ──────────────────────────────────────────────────────────────
-- SELECT: je eigen company + companies waarmee je een relatie hebt (beide richtingen).
-- Nodig zodat de bedrijfsnamen in de dropdown/lijst zichtbaar blijven onder RLS.
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
for select using (
  id = public.current_company_id()
  or public.has_active_relationship(public.current_company_id(), id)  -- ik ben client, id is contractor
  or public.has_active_relationship(id, public.current_company_id())  -- id is client, ik ben contractor
);


-- ── profiles ───────────────────────────────────────────────────────────────
-- SELECT: profielen binnen je eigen company (voor de Medewerkers-lijst + eigen profiel).
-- ⚠️  Zonder deze policy breekt login (loadProfileAndRoute leest je eigen profiel).
--    current_company_id() is SECURITY DEFINER en omzeilt RLS, dus geen recursie.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select using (
  company_id = public.current_company_id()
);


-- ============================================================================
-- RLS AANZETTEN — pas NA review en testen, één tabel tegelijk, regels los uncommenten.
-- ============================================================================
-- alter table public.registrations          enable row level security;
-- alter table public.company_relationships   enable row level security;
-- alter table public.companies               enable row level security;
-- alter table public.profiles                enable row level security;
