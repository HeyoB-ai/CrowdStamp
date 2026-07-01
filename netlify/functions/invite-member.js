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

function respond(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

async function emailExists(email) {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 100; i++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    if (data.users.some(u => (u.email || '').toLowerCase() === target)) return true;
    if (data.users.length < perPage) return false;
    page++;
  }
  return false;
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
    return respond(403, { error: 'Alleen beheerders kunnen medewerkers uitnodigen' });
  }

  // ── Parse + validate ──
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Ongeldige aanvraag' }); }

  const naam = (body.naam || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const functie = (body.functie || '').trim();

  if (!naam || !email || !functie) return respond(400, { error: 'Vul alle velden in' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: 'Voer een geldig e-mailadres in' });
  if (!FUNCTIE_VALUES.includes(functie)) return respond(400, { error: 'Ongeldige functie' });

  try {
    // ── Duplicate check ──
    if (await emailExists(email)) {
      return respond(400, { error: 'Dit e-mailadres is al geregistreerd' });
    }

    // ── Invite (sends magic-link welcome email automatically) ──
    const { data: invited, error: inviteErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: {
        role: 'worker',
        company_id: caller.company_id,
        full_name: naam,
        functie: functie,
      },
      redirectTo: 'https://crowdstamp.netlify.app/app',
    });

    if (inviteErr) {
      console.error('[invite-member] invite error:', inviteErr);
      const msg = (inviteErr.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || inviteErr.status === 422) {
        return respond(400, { error: 'Dit e-mailadres is al geregistreerd' });
      }
      return respond(500, { error: 'Uitnodiging versturen mislukt: ' + (inviteErr.message || 'onbekende fout') });
    }

    const newUserId = invited?.user?.id;
    if (!newUserId) {
      return respond(500, { error: 'Geen gebruiker-ID ontvangen van Supabase' });
    }

    // ── Upsert profile (the on_auth_user_created trigger may have created the basics; this fills in functie/email/status) ──
    const { error: profileErr } = await sb.from('profiles').upsert({
      id: newUserId,
      company_id: caller.company_id,
      role: 'worker',
      full_name: naam,
      email: email,
      functie: functie,
      status: 'invited',
    }, { onConflict: 'id' });

    if (profileErr) {
      console.error('[invite-member] profile upsert error:', profileErr);
      return respond(200, {
        success: true,
        message: 'Uitnodiging verstuurd (profielupdate gedeeltelijk mislukt)',
        warning: profileErr.message,
      });
    }

    return respond(200, { success: true, message: 'Uitnodiging verstuurd' });
  } catch (err) {
    console.error('[invite-member] unexpected error:', err);
    return respond(500, { error: err.message || 'Er ging iets mis' });
  }
};
