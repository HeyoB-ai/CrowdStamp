-- Model B: veel-op-veel relatie opdrachtgever <-> onderaannemer-bedrijf.
-- Een rij betekent: client_company heeft contractor_company ingeschakeld.
--
-- DRAAI DIT HANDMATIG in de Supabase SQL Editor (niet automatisch uitgevoerd).

create table if not exists public.company_relationships (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid not null references public.companies(id) on delete cascade,
  contractor_company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (client_company_id, contractor_company_id)
);
