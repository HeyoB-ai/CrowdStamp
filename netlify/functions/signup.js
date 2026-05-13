const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function emailExists(email) {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 200;
  // Paginate auth users to find a match. Fine for early-stage scale.
  // At scale, replace with a SECURITY DEFINER RPC that does `select 1 from auth.users where email = $1`.
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ongeldige aanvraag' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  const companyName = (body.company_name || '').trim();

  if (!email || !name || !companyName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Vul alle velden in' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Voer een geldig e-mailadres in' }) };
  }

  let newCompanyId = null;
  try {
    // 1. Refuse if the email is already registered
    if (await emailExists(email)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Dit e-mailadres is al geregistreerd' }) };
    }

    // 2. Insert company (with 14-day trial expiry set in the same row)
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: company, error: cErr } = await sb.from('companies').insert({
      name: companyName,
      plan: 'trial',
      status: 'active',
      trial_ends_at: trialEndsAt,
    }).select('id').single();
    if (cErr || !company) {
      console.error('Company insert failed:', cErr);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Bedrijf aanmaken mislukt' }) };
    }
    newCompanyId = company.id;

    // 3. Invite admin via Supabase Auth (sends magic-link welcome email automatically)
    const { error: inviteErr } = await sb.auth.admin.inviteUserByEmail(email, {
      data: {
        role: 'admin',
        company_id: newCompanyId,
        full_name: name,
      },
      redirectTo: 'https://crowdstamp.netlify.app/app',
    });
    if (inviteErr) {
      console.error('Invite failed:', inviteErr);
      // Clean up orphan company so the user can retry
      await sb.from('companies').delete().eq('id', newCompanyId);
      const msg = (inviteErr.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || inviteErr.status === 422) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Dit e-mailadres is al geregistreerd' }) };
      }
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Uitnodiging versturen mislukt' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'Uitnodiging verstuurd' }),
    };
  } catch (err) {
    console.error('signup error:', err);
    if (newCompanyId) {
      // Best-effort cleanup if something blew up after company creation
      try { await sb.from('companies').delete().eq('id', newCompanyId); } catch {}
    }
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Er ging iets mis. Probeer het opnieuw.' }),
    };
  }
};
