const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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

// Plan → env-var that holds its Stripe price-id (same names as the webhook uses).
const PRICE_ENV = {
  growth: 'STRIPE_GROWTH_PRICE_ID',
  pro: 'STRIPE_PRO_PRICE_ID',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { plan } = body;
  if (plan !== 'growth' && plan !== 'pro') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ongeldig plan (kies growth of pro)' }) };
  }

  const priceId = process.env[PRICE_ENV[plan]];
  if (!priceId) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Prijs niet geconfigureerd (${PRICE_ENV[plan]} ontbreekt)` }) };
  }

  // Caller must be an authenticated admin/superuser of their own company.
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Auth required' }) };
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const { data: u, error: uErr } = await sb.auth.getUser(token);
  if (uErr || !u?.user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid auth token' }) };

  const { data: profile, error: pErr } = await sb
    .from('profiles').select('company_id, role')
    .eq('id', u.user.id).single();
  if (pErr || !profile) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Profile not found' }) };
  if (!profile.company_id) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Geen bedrijf gekoppeld' }) };
  if (profile.role !== 'admin' && profile.role !== 'superuser') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Only admins can manage billing' }) };
  }

  const companyId = profile.company_id;
  const { data: company, error: cErr } = await sb
    .from('companies').select('stripe_customer_id')
    .eq('id', companyId).single();
  if (cErr || !company) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Bedrijf niet gevonden' }) };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { companyId, plan },
      },
      // The webhook reads session.metadata.companyId and .plan.
      metadata: { companyId, plan },
      ...(company.stripe_customer_id
        ? { customer: company.stripe_customer_id }
        : { customer_email: u.user.email }),
      success_url: 'https://crowdstamp.netlify.app/index.html?checkout=success',
      cancel_url: 'https://crowdstamp.netlify.app/index.html?checkout=cancel',
      allow_promotion_codes: true,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
