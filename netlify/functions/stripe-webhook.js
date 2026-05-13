const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function planFromPrice(priceId) {
  if (priceId === process.env.STRIPE_GROWTH_PRICE_ID) return 'growth';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  return null;
}

function mappedStatus(subStatus) {
  if (subStatus === 'active' || subStatus === 'trialing') return 'active';
  if (subStatus === 'past_due' || subStatus === 'unpaid') return 'paused';
  if (subStatus === 'canceled' || subStatus === 'paused') return 'paused';
  return subStatus || 'unknown';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig) return { statusCode: 400, body: 'Missing stripe-signature header' };

  // Stripe signature verification needs the raw body bytes exactly as sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook signature error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const companyId = session.metadata?.companyId || '';
        const plan = session.metadata?.plan || 'growth';
        if (!companyId) {
          // New-signup flow (homepage CTA without an existing company) not yet implemented.
          // Provision the company manually or extend this branch to insert one.
          console.warn('[checkout.session.completed] No companyId in metadata. Customer:', session.customer, 'Email:', session.customer_email);
          break;
        }
        const { error } = await sb.from('companies').update({
          stripe_customer_id: session.customer,
          plan,
          status: 'active',
        }).eq('id', companyId);
        if (error) console.error('Supabase update error (checkout.completed):', error);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan = planFromPrice(priceId);
        const updates = { status: mappedStatus(sub.status) };
        if (plan) updates.plan = plan;
        const { error } = await sb.from('companies').update(updates).eq('stripe_customer_id', sub.customer);
        if (error) console.error('Supabase update error (subscription.updated):', error);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const { error } = await sb.from('companies').update({
          plan: 'trial',
          status: 'paused',
        }).eq('stripe_customer_id', sub.customer);
        if (error) console.error('Supabase update error (subscription.deleted):', error);
        break;
      }
      default:
        break;
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
