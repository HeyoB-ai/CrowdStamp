-- Model B: koppel een registratie optioneel aan de opdrachtgever-company.
-- NULL = Model A (registratie hoort enkel bij de eigen company via company_id).
-- Gevuld = de uren zijn gedraaid voor deze opdrachtgever (een client_company).
--
-- DRAAI DIT HANDMATIG in de Supabase SQL Editor (niet automatisch uitgevoerd).

alter table public.registrations
  add column if not exists client_company_id uuid references public.companies(id);
