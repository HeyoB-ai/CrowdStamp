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

function planFromSession(session) {
  const meta = session.metadata?.plan;
  if (meta === 'growth' || meta === 'pro') return meta;
  const fromPrice = planFromPrice(session.line_items?.data?.[0]?.price?.id);
  return fromPrice || 'growth';
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
        // Re-retrieve with line_items expanded — webhook payloads don't include them by default
        let session;
        try {
          session = await stripe.checkout.sessions.retrieve(
            stripeEvent.data.object.id,
            { expand: ['line_items'] }
          );
        } catch (err) {
          console.error('Failed to retrieve session:', err);
          break;
        }

        const companyId = session.metadata?.companyId || '';
        const plan = planFromSession(session);
        const stripeCustomerId = session.customer;

        // ── Existing company upgrading plan → just update billing fields ──
        if (companyId) {
          try {
            const { error } = await sb.from('companies').update({
              stripe_customer_id: stripeCustomerId,
              plan,
              status: 'active',
            }).eq('id', companyId);
            if (error) throw error;
          } catch (err) {
            console.error('Company update failed:', err);
          }
          break;
        }

        // ── New signup → auto-provision company + admin user ──
        const email = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name || null;

        if (!email) {
          console.error('[checkout.session.completed] No customer email; cannot provision new signup');
          break;
        }

        // 1) Insert company
        let newCompanyId = null;
        try {
          const companyName = name || email;
          const { data: company, error } = await sb.from('companies').insert({
            name: companyName,
            stripe_customer_id: stripeCustomerId,
            plan,
            status: 'active',
          }).select('id').single();
          if (error) throw error;
          newCompanyId = company.id;
        } catch (err) {
          console.error('Company insert failed:', err);
          break; // can't proceed without a company
        }

        // 2) Invite admin via Supabase Auth (sends magic-link welcome email automatically)
        let authUserId = null;
        try {
          const { data: invited, error } = await sb.auth.admin.inviteUserByEmail(email, {
            data: {
              role: 'admin',
              company_id: newCompanyId,
              full_name: name || '',
            },
            redirectTo: 'https://crowdstamp.netlify.app/app',
          });
          if (error) throw error;
          authUserId = invited?.user?.id || null;
        } catch (err) {
          console.error('Invite admin failed:', err);
        }

        // 3) Ensure profile row (idempotent — the on_auth_user_created trigger may already have inserted it)
        if (authUserId) {
          try {
            const { error } = await sb.from('profiles').upsert({
              id: authUserId,
              company_id: newCompanyId,
              role: 'admin',
              full_name: name || email,
            }, { onConflict: 'id', ignoreDuplicates: true });
            if (error) throw error;
          } catch (err) {
            console.error('Profile upsert failed:', err);
          }
        }

        console.log(`Provisioned company ${newCompanyId} (${name || email}) for ${email}`);
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
