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

function respond(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return respond(401, { error: 'Niet ingelogd' });
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const { data: u, error: uErr } = await sb.auth.getUser(token);
  if (uErr || !u?.user) return respond(401, { error: 'Ongeldige sessie' });
  const callerId = u.user.id;

  const { data: caller, error: pErr } = await sb
    .from('profiles')
    .select('company_id, role')
    .eq('id', callerId)
    .single();
  if (pErr || !caller) return respond(403, { error: 'Profiel niet gevonden' });
  if (caller.role !== 'admin' && caller.role !== 'superuser') {
    return respond(403, { error: 'Alleen beheerders kunnen medewerkers verwijderen' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Ongeldige aanvraag' }); }

  const { userId } = body;
  if (!userId) return respond(400, { error: 'userId ontbreekt' });

  if (userId === callerId) {
    return respond(400, { error: 'Je kunt jezelf niet verwijderen' });
  }

  const { data: target, error: tErr } = await sb
    .from('profiles')
    .select('id, role, company_id, status, full_name')
    .eq('id', userId)
    .single();
  if (tErr || !target) return respond(404, { error: 'Medewerker niet gevonden' });
  if (target.company_id !== caller.company_id) {
    return respond(403, { error: 'Geen toegang tot deze medewerker' });
  }

  // ── Last-admin guard ──
  if (target.role === 'admin' || target.role === 'superuser') {
    const { count, error: countErr } = await sb
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', caller.company_id)
      .in('role', ['admin', 'superuser'])
      .eq('status', 'active');
    if (countErr) {
      console.error('[remove-member] admin count error:', countErr);
      return respond(500, { error: 'Beheerder-controle mislukt' });
    }
    if ((count ?? 0) <= 1) {
      return respond(400, { error: 'Er moet minimaal één beheerder blijven' });
    }
  }

  try {
    const { error: updErr } = await sb.from('profiles')
      .update({ status: 'inactive' })
      .eq('id', userId);
    if (updErr) {
      console.error('[remove-member] update error:', updErr);
      return respond(500, { error: 'Verwijderen mislukt: ' + updErr.message });
    }
    return respond(200, { success: true });
  } catch (err) {
    console.error('[remove-member] unexpected error:', err);
    return respond(500, { error: err.message || 'Er ging iets mis' });
  }
};
