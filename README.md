# PostCrew — AI social media agent

Customers describe their brand, pick platforms and a goal, and get a ready-to-post
content plan (hooks, captions, hashtags, visual ideas, best times). Paid monthly
subscriptions through Stripe.

- **Free trial:** 3 content plans, up to 7 posts each
- **Starter — €9/month:** 30 plans a month, up to 14 posts each
- **Pro — €29/month:** 150 plans a month, up to 30 posts each

The whole app has **no npm packages and no build step**. That keeps it simple to run and
maintain from a phone.

```
public/        Website: landing page, app, terms, privacy
api/           Server functions (Vercel): generate, brand, me, checkout, portal, webhook, config
lib/shared.js  Shared helpers: plans, Supabase, Stripe, login check
supabase/      Database setup (one SQL file)
tests/         Offline test server + 24 automated tests (node tests/run.js)
```

To change plan limits, edit `PLANS` in `lib/shared.js`. To change the prices shown on
the site, edit `public/index.html` and `public/app.html` (the real price comes from Stripe).

---

## Setup guide (can all be done from a phone browser)

Do the steps in order. Keep a notes app open to paste the keys you collect.
Never share the **secret** keys with anyone or put them in the code.

### 1. Supabase (logins + database) — free

1. Go to **supabase.com** → Sign up with GitHub → **New project**.
   Name: `postcrew`, choose a strong database password, region **Europe (Frankfurt or Paris)**.
2. When it's ready, open **SQL Editor → New query**, paste everything from
   `supabase/schema.sql`, tap **Run**. You should see "Success".
3. Open **Project Settings → API** and copy:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (secret!)

### 2. Claude API key (the AI) — pay as you go

1. Go to **console.anthropic.com** → sign up → **Billing**: add a small credit (e.g. $5–10).
2. **Settings → Limits**: set a monthly spend limit so you never get a surprise bill.
3. **API Keys → Create key** → copy it → `ANTHROPIC_API_KEY` (secret!).

### 3. Stripe (payments) — free, they take a fee per payment

Start in **Test mode** (the toggle at the top). Nothing is charged for real.

1. **Product catalogue → Add product**
   - Name `PostCrew Starter`, price **€9.00**, **Recurring, Monthly** → Save.
     Open the price and copy its ID (`price_...`) → `STRIPE_PRICE_STARTER`
   - Same again: `PostCrew Pro`, **€29.00** monthly → `STRIPE_PRICE_PRO`
2. **Settings → Billing → Customer portal** → turn it on. Allow customers to
   cancel, update payment method, and switch plans between Starter and Pro. Save.
3. **Developers → API keys** → copy **Secret key** (`sk_test_...`) → `STRIPE_SECRET_KEY` (secret!)
4. The webhook is set up in step 5, after you have your website address.

### 4. Vercel (hosting) — free

1. First the code must be in a GitHub repository (ask Claude to push it to your GitHub).
2. Go to **vercel.com** → Sign up with GitHub → **Add New → Project** → import `postcrew`.
3. Framework preset: **Other**. Leave Build and Output settings empty.
4. Open **Environment Variables** and add every key from `.env.example`:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
   `ANTHROPIC_MODEL` (`claude-haiku-5-5`), `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`.
5. Tap **Deploy**. When it finishes you get an address like `https://postcrew-abc.vercel.app`.
6. Add one more variable: `SITE_URL` = that address (no slash at the end).

### 5. Connect everything

1. **Stripe → Developers → Webhooks → Add endpoint**
   - URL: `https://YOUR-ADDRESS.vercel.app/api/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Save, then copy the **Signing secret** (`whsec_...`) → add to Vercel as `STRIPE_WEBHOOK_SECRET`.
2. **Supabase → Authentication → URL Configuration**
   - Site URL: `https://YOUR-ADDRESS.vercel.app/app.html`
   - Redirect URLs: add `https://YOUR-ADDRESS.vercel.app/**`
3. **Vercel → Deployments → ⋯ → Redeploy** so the new variables are used.

### 6. Test it

1. Open your address, tap **Start free**, create an account, confirm the email.
2. Fill in a brand, create a content plan.
3. Go to **Account → Choose Starter**, pay with Stripe's test card
   **4242 4242 4242 4242**, any future date, any CVC.
4. You should come back to the app on **Starter**. Try **Manage billing** and cancel — you go back to Free.

### 7. Going live (real money)

- Activate your Stripe account (you'll need your NIF, ID and IBAN).
- Switch Stripe to **Live mode**, create the two products again, a live webhook, and
  replace `STRIPE_SECRET_KEY`, `STRIPE_PRICE_*` and `STRIPE_WEBHOOK_SECRET` in Vercel with the live ones. Redeploy.
- Fill in `public/terms.html` and `public/privacy.html` with your details.
- In Portugal you need an open activity (*atividade*) at Finanças and must issue invoices
  for sales; VAT rules apply to EU customers. Stripe Tax and Stripe Invoicing can help.
  Check with an accountant (*contabilista*) before launch.
- Optional: buy a domain and add it in Vercel → Settings → Domains, then update `SITE_URL`,
  the Stripe webhook URL and the Supabase URLs.

## Costs

- Supabase, Vercel: free tiers are enough to start.
- Stripe: a small % + fixed fee per successful payment, nothing monthly.
- Claude API: you pay per content plan generated. Bigger plans (30 posts) cost more than small
  ones. Check current prices at anthropic.com/pricing, keep the spend limit on, and watch
  the usage page in the first weeks to make sure your prices cover it.

## Running the tests

```
node tests/run.js            # 24 API tests with fake Supabase/Stripe/Claude
node tests/devserver.js      # full app at http://localhost:4321 with fake services
```
