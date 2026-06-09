const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FUNCTIE_VALUES = ['medewerker', 'onderaannemer', 'service_monteur'];
const PAID_PLANS = ['growth', 'groei', 'pro'];

function respond(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

// Mag deze company onderaannemers inschakelen? Betaald plan of geldige, niet-verlopen trial.
function canEngage(company) {
  if (!company) return false;
  if (PAID_PLANS.includes(company.plan)) return true;
  if (company.plan === 'trial' && company.trial_ends_at) {
    const endsAt = new Date(company.trial_ends_at).getTime();
    if (!isNaN(endsAt) && endsAt > Date.now()) return true;
  }
  return false;
}

async function findProfileByEmail(email) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, company_id')
    .eq('email', email)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method Not Allowed' });

  // ── Auth ──
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return respond(401, { error: 'Niet ingelogd' });
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const { data: u, error: uErr } = await sb.auth.getUser(token);
  if (uErr || !u?.user) return respond(401, { error: 'Ongeldige sessie' });

  const { data: caller, error: pErr } = await sb
    .from('profiles')
    .select('company_id, role')
    .eq('id', u.user.id)
    .single();
  if (pErr || !caller) return respond(403, { error: 'Profiel niet gevonden' });
  if (caller.role !== 'admin' && caller.role !== 'superuser') {
    return respond(403, { error: 'Alleen beheerders kunnen onderaannemers inschakelen' });
  }
  if (!caller.company_id) return respond(403, { error: 'Geen bedrijf gekoppeld' });

  // ── Plan-gate: alleen betaald plan of geldige trial ──
  const { data: clientCompany, error: cErr } = await sb
    .from('companies')
    .select('id, plan, status, trial_ends_at')
    .eq('id', caller.company_id)
    .single();
  if (cErr || !clientCompany) return respond(403, { error: 'Bedrijf niet gevonden' });
  if (!canEngage(clientCompany)) {
    return respond(403, {
      error: 'Upgrade je abonnement om onderaannemers in te schakelen',
      code: 'UPGRADE_REQUIRED',
    });
  }

  // ── Parse + validate ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Ongeldige aanvraag' }); }

  const email = (body.email || '').trim().toLowerCase();
  const companyName = (body.companyName || '').trim();
  const functie = (body.functie || '').trim();

  if (!email || !companyName) return respond(400, { error: 'Vul bedrijfsnaam en e-mailadres in' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: 'Voer een geldig e-mailadres in' });
  if (functie && !FUNCTIE_VALUES.includes(functie)) return respond(400, { error: 'Ongeldige functie' });

  try {
    // ── Bepaal de contractor-company ──
    let contractorCompanyId = null;
    let invited = false;

    const existing = await findProfileByEmail(email);
    if (existing && existing.company_id) {
      // Profiel bestaat al → koppel aan diens bestaande company.
      contractorCompanyId = existing.company_id;
    } else {
      // Nog geen company → maak er een aan en nodig de persoon uit als admin.
      const { data: newCompany, error: newErr } = await sb
        .from('companies')
        .insert({ name: companyName, plan: 'starter', status: 'active' })
        .select('id')
        .single();
      if (newErr || !newCompany) {
        console.error('[engage-contractor] company insert error:', newErr);
        return respond(500, { error: 'Onderaannemer-bedrijf aanmaken mislukt' });
      }
      contractorCompanyId = newCompany.id;

      const { error: inviteErr } = await sb.auth.admin.inviteUserByEmail(email, {
        data: {
          role: 'admin',
          company_id: contractorCompanyId,
          full_name: companyName,
          functie: functie || null,
        },
        redirectTo: 'https://crowdstamp.netlify.app/index.html',
      });
      if (inviteErr) {
        console.error('[engage-contractor] invite error:', inviteErr);
        // Rol de zojuist aangemaakte company terug zodat er geen wees-company blijft staan.
        try { await sb.from('companies').delete().eq('id', contractorCompanyId); }
        catch (cleanupErr) { console.error('[engage-contractor] cleanup failed:', cleanupErr); }
        const msg = (inviteErr.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('registered') || inviteErr.status === 422) {
          return respond(400, {
            error: 'Dit e-mailadres bestaat al maar heeft nog geen bedrijf. Laat de persoon eerst inloggen.',
          });
        }
        return respond(500, { error: 'Uitnodiging versturen mislukt: ' + (inviteErr.message || 'onbekende fout') });
      }
      invited = true;
    }

    // ── Zelf-inschakelen voorkomen ──
    if (contractorCompanyId === caller.company_id) {
      return respond(400, { error: 'Je kunt je eigen bedrijf niet als onderaannemer inschakelen' });
    }

    // ── Relatie-rij aanmaken (on conflict do nothing) ──
    const { error: relErr } = await sb
      .from('company_relationships')
      .upsert(
        {
          client_company_id: caller.company_id,
          contractor_company_id: contractorCompanyId,
          status: 'active',
        },
        { onConflict: 'client_company_id,contractor_company_id', ignoreDuplicates: true }
      );
    if (relErr) {
      console.error('[engage-contractor] relationship upsert error:', relErr);
      return respond(500, { error: 'Koppeling aanmaken mislukt: ' + relErr.message });
    }

    return respond(200, {
      success: true,
      invited,
      contractor_company_id: contractorCompanyId,
      message: invited
        ? 'Onderaannemer uitgenodigd en ingeschakeld'
        : 'Onderaannemer ingeschakeld',
    });
  } catch (err) {
    console.error('[engage-contractor] unexpected error:', err);
    return respond(500, { error: err.message || 'Er ging iets mis' });
  }
};
