const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  growth: process.env.STRIPE_GROWTH_PRICE_ID,
  pro: process.env.STRIPE_PRO_PRICE_ID,
};

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { plan, companyId, email } = body;

  if (!plan || !email) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing plan or email' }) };
  }
  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown plan' }) };
  }

  // If companyId is supplied, require an authenticated caller and verify ownership.
  if (companyId) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Auth required for companyId' }) };
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: u, error: uErr } = await sb.auth.getUser(token);
    if (uErr || !u?.user) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }
    const { data: profile } = await sb
      .from('profiles').select('company_id, role')
      .eq('id', u.user.id).single();
    if (!profile || profile.company_id !== companyId) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden' }) };
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: 'https://crowdstamp.nl/app?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://crowdstamp.nl/#pricing',
      metadata: { companyId: companyId || '', plan, email },
      subscription_data: {
        trial_period_days: 14,
        metadata: { companyId: companyId || '', plan },
      },
      allow_promotion_codes: true,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
