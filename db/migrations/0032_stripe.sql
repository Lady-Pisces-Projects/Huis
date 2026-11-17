-- Phase 10 part 2: online payment through Stripe, and the trial Tracy chose on 11 November 2026.
--
-- Decisions (10–11 November 2026, open item O-11 settled):
--   * The 7-day free trial needs no card and allows 1 seat and 1 Matter (plus the existing storage and AI
--     limits, so nobody can load a whole discovery set for free).
--   * Professional: $237 per seat per month, or $2,370 per seat per year (two months free). Paid through
--     Stripe's own checkout page; cards, invoices and cancelling are handled in Stripe's customer portal.
--     Huis never sees card numbers.
--   * When access ends (the trial runs out unpaid, or the subscription ends), the firm's work is read and
--     export only for 30 days, then deleted. The deletion itself is the next part (10.2b); this migration
--     records the date so the firm is told it.
--
-- Who can change what:
--   * Stripe's state is written only by huis.billing_apply_subscription(), which only the huis_billing role
--     may call. The webhook uses a login in that role and nothing else; the app (huis_app) cannot grant a
--     firm a plan.
--   * The app may record its firm's Stripe customer once, at checkout (huis.my_firm_set_stripe_customer).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huis_billing') THEN
    CREATE ROLE huis_billing NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA huis TO huis_billing;

-- ---------------------------------------------------------------------------
-- Plans: a Matter limit, a yearly price, and the trial's new limits.
-- ---------------------------------------------------------------------------
ALTER TABLE huis.plans
  ADD COLUMN matter_limit int CHECK (matter_limit IS NULL OR matter_limit >= 0),
  ADD COLUMN price_cents_per_seat_year int CHECK (price_cents_per_seat_year IS NULL OR price_cents_per_seat_year >= 0);
UPDATE huis.plans SET seat_limit = 1, matter_limit = 1 WHERE code = 'trial';
UPDATE huis.plans SET price_cents_per_seat_year = 237000 WHERE code = 'professional';

-- ---------------------------------------------------------------------------
-- The firm's Stripe account. Huis's to set, like the plan (the guard below).
-- ---------------------------------------------------------------------------
ALTER TABLE huis.firms
  ADD COLUMN stripe_customer_id     text UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,255}$'),
  ADD COLUMN stripe_subscription_id text CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,255}$'),
  ADD COLUMN stripe_status          text CHECK (stripe_status IN (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  ADD COLUMN billing_interval       text CHECK (billing_interval IN ('month', 'year')),
  -- When a paid subscription ended (cancelled, unpaid after Stripe's retries, or paused). Null while live.
  ADD COLUMN access_ended_at        timestamptz;

CREATE OR REPLACE FUNCTION huis.firms_subscription_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'huis_security' AND (
       NEW.seat_limit IS DISTINCT FROM OLD.seat_limit OR NEW.paid_through IS DISTINCT FROM OLD.paid_through
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.stripe_status IS DISTINCT FROM OLD.stripe_status
    OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
    OR NEW.access_ended_at IS DISTINCT FROM OLD.access_ended_at) THEN
    RAISE EXCEPTION 'Plan, trial and account status are managed by Huis';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- When the firm's access ended, and when its data will be deleted (30 days later).
-- Null while the firm has access, and for a firm Huis suspended by hand (Huis decides those).
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.firm_access_ended_at(p_firm_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN f.status <> 'active' THEN NULL
    WHEN f.plan = 'trial' THEN CASE WHEN f.trial_ends_at <= now() THEN f.trial_ends_at END
    WHEN f.access_ended_at IS NOT NULL THEN f.access_ended_at
    -- A paid plan that ran past its paid-through date and the 7 days' grace.
    WHEN f.paid_through IS NOT NULL AND f.paid_through + interval '7 days' <= now() THEN f.paid_through + interval '7 days'
  END
  FROM huis.firms f WHERE f.id = p_firm_id
$$;
CREATE FUNCTION huis.firm_delete_after(p_firm_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.firm_access_ended_at(p_firm_id) + interval '30 days'
$$;
ALTER FUNCTION huis.firm_access_ended_at(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.firm_delete_after(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_access_ended_at(uuid), huis.firm_delete_after(uuid) FROM PUBLIC;

-- Firm staff are told the date; outside users never learn the firm's standing (security review 24, R24-2).
CREATE FUNCTION huis.my_firm_delete_after() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE WHEN huis.current_firm_id() IS NULL OR NOT coalesce(huis.is_internal_role(huis.app_role()), false) THEN NULL
              ELSE huis.firm_delete_after(huis.current_firm_id()) END
$$;
ALTER FUNCTION huis.my_firm_delete_after() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_delete_after() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_delete_after() TO huis_app;

-- A subscription that ended pauses new work at once (no grace: the firm chose to end it, or Stripe's retries
-- are exhausted). Everything else is as before.
CREATE OR REPLACE FUNCTION huis.firm_write_block(p_firm_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN f.id IS NULL THEN 'This firm was not found.'
    WHEN f.status <> 'active' THEN
      'This firm''s Huis account is suspended. You can still open and export your work; contact Huis to restore it.'
    WHEN f.plan = 'trial' AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now()) THEN
      'The firm''s free trial has ended. You can still open and export everything; adding new work is paused until the firm subscribes.'
    WHEN f.plan <> 'trial' AND f.access_ended_at IS NOT NULL THEN
      'The firm''s subscription has ended. You can still open and export everything; adding new work is paused until the firm subscribes again.'
    WHEN f.plan <> 'trial' AND f.paid_through IS NOT NULL AND f.paid_through + interval '7 days' <= now() THEN
      'The firm''s subscription payment is overdue. You can still open and export everything; adding new work is paused until it is paid.'
  END
  FROM (SELECT p_firm_id AS id) want LEFT JOIN huis.firms f ON f.id = want.id
$$;

-- ---------------------------------------------------------------------------
-- Matters: the trial allows one. Counted across the whole firm (walled Matters included).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION huis.firm_limits(p_firm_id uuid,
  OUT plan text, OUT seat_limit int, OUT storage_limit_bytes bigint, OUT ai_questions_per_month int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.plan, coalesce(f.seat_limit, p.seat_limit), p.storage_limit_bytes, p.ai_questions_per_month
    FROM huis.firms f JOIN huis.plans p ON p.code = f.plan WHERE f.id = p_firm_id
$$;
CREATE FUNCTION huis.firm_matter_limit(p_firm_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT p.matter_limit FROM huis.firms f JOIN huis.plans p ON p.code = f.plan WHERE f.id = p_firm_id
$$;
CREATE FUNCTION huis.firm_matters_used(p_firm_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT count(*)::int FROM huis.matters WHERE firm_id = p_firm_id
$$;
ALTER FUNCTION huis.firm_matter_limit(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.firm_matters_used(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_matter_limit(uuid), huis.firm_matters_used(uuid) FROM PUBLIC;
GRANT SELECT ON huis.matters TO huis_security;

CREATE FUNCTION huis.matter_limit_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_limit int;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_limit := huis.firm_matter_limit(NEW.firm_id);
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  -- One at a time per firm, or two requests could both create the last Matter allowed.
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  IF huis.firm_matters_used(NEW.firm_id) + 1 > v_limit THEN
    RAISE EXCEPTION 'The free trial includes % Matter%. Subscribe to add more.', v_limit, CASE WHEN v_limit = 1 THEN '' ELSE 's' END
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION huis.matter_limit_check() OWNER TO huis_security;
-- Named to run after matters_subscription (triggers fire in name order).
CREATE TRIGGER matters_subscription_limit BEFORE INSERT ON huis.matters
  FOR EACH ROW EXECUTE FUNCTION huis.matter_limit_check();

-- The seat message no longer tells paid firms to ask Huis: a Stripe firm has no seat cap (each seat is billed).
CREATE OR REPLACE FUNCTION huis.license_seat_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit int; v_used int; v_plan text;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  IF NEW.status <> 'active' OR NEW.kind NOT IN ('attorney', 'staff') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.kind IN ('attorney', 'staff') AND OLD.firm_id = NEW.firm_id THEN
    RETURN NEW;
  END IF;
  v_block := huis.write_block_for_caller(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  SELECT l.seat_limit, l.plan INTO v_limit, v_plan FROM huis.firm_limits(NEW.firm_id) l;
  IF v_limit IS NOT NULL THEN
    v_used := huis.firm_seats_used(NEW.firm_id, NEW.id);
    IF v_used + 1 > v_limit THEN
      IF v_plan = 'trial' THEN
        RAISE EXCEPTION 'The free trial includes % seat%. Subscribe to add attorneys and staff. (Clients, co-counsel and experts don''t take a seat.)',
          v_limit, CASE WHEN v_limit = 1 THEN '' ELSE 's' END USING ERRCODE = 'HU402';
      END IF;
      RAISE EXCEPTION 'All % of the firm''s seats are in use. Disable someone''s access first, or ask Huis to add seats. (Clients, co-counsel and experts don''t take a seat.)', v_limit
        USING ERRCODE = 'HU402';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The firm's subscription page (numbers only), now with Matters, the yearly price and the deletion date.
-- ---------------------------------------------------------------------------
DROP FUNCTION huis.my_firm_subscription();
CREATE FUNCTION huis.my_firm_subscription(
  OUT plan text, OUT plan_name text, OUT price_cents_per_seat int, OUT price_cents_per_seat_year int,
  OUT trial_ends_at timestamptz, OUT paid_through timestamptz,
  OUT seat_limit int, OUT seats_used int, OUT external_users int,
  OUT matter_limit int, OUT matters_used int,
  OUT storage_limit_bytes bigint, OUT storage_used_bytes bigint,
  OUT ai_questions_per_month int, OUT ai_questions_used int, OUT write_block text,
  OUT billing_interval text, OUT stripe_status text, OUT has_billing_account boolean,
  OUT access_ended_at timestamptz, OUT delete_after timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); l record;
BEGIN
  IF v_firm IS NULL OR coalesce(huis.app_role()::text, '') NOT IN ('firm_owner', 'managing_partner', 'firm_admin', 'billing_admin') THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM huis.firm_limits(v_firm);
  SELECT f.plan, p.name, p.price_cents_per_seat, p.price_cents_per_seat_year, f.trial_ends_at, f.paid_through,
         f.billing_interval, f.stripe_status, f.stripe_customer_id IS NOT NULL
    INTO plan, plan_name, price_cents_per_seat, price_cents_per_seat_year, trial_ends_at, paid_through,
         billing_interval, stripe_status, has_billing_account
    FROM huis.firms f JOIN huis.plans p ON p.code = f.plan WHERE f.id = v_firm;
  seat_limit := l.seat_limit;
  seats_used := huis.firm_seats_used(v_firm);
  external_users := (SELECT count(*)::int FROM huis.licenses x WHERE x.firm_id = v_firm AND x.status = 'active' AND x.kind = 'external');
  matter_limit := huis.firm_matter_limit(v_firm);
  matters_used := huis.firm_matters_used(v_firm);
  storage_limit_bytes := l.storage_limit_bytes;
  storage_used_bytes := huis.firm_storage_used(v_firm);
  ai_questions_per_month := l.ai_questions_per_month;
  ai_questions_used := huis.firm_ai_questions_this_month(v_firm);
  write_block := huis.firm_write_block(v_firm);
  access_ended_at := huis.firm_access_ended_at(v_firm);
  delete_after := huis.firm_delete_after(v_firm);
END $$;
ALTER FUNCTION huis.my_firm_subscription() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_subscription() TO huis_app;

-- ---------------------------------------------------------------------------
-- Checkout (the app, for the people who manage the account).
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.billing_manager_firm() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id();
BEGIN
  IF v_firm IS NULL OR huis.current_user_id() IS NULL
     OR coalesce(huis.app_role()::text, '') NOT IN ('firm_owner', 'managing_partner', 'firm_admin', 'billing_admin') THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_firm;
END $$;
ALTER FUNCTION huis.billing_manager_firm() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.billing_manager_firm() FROM PUBLIC;

-- What checkout needs about the caller's own firm.
CREATE FUNCTION huis.my_firm_checkout(
  OUT firm_id uuid, OUT firm_name text, OUT stripe_customer_id text, OUT seats_used int,
  OUT trial_ends_at timestamptz, OUT subscribed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.billing_manager_firm();
BEGIN
  SELECT f.id, f.name, f.stripe_customer_id, huis.firm_seats_used(f.id),
         CASE WHEN f.plan = 'trial' THEN f.trial_ends_at END,
         f.plan <> 'trial' AND f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL
    INTO firm_id, firm_name, stripe_customer_id, seats_used, trial_ends_at, subscribed
    FROM huis.firms f WHERE f.id = v_firm;
END $$;
ALTER FUNCTION huis.my_firm_checkout() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_checkout() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_checkout() TO huis_app;

-- Records the firm's Stripe customer, once. Never replaced (a firm can't swap in another firm's customer).
CREATE FUNCTION huis.my_firm_set_stripe_customer(p_customer text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.billing_manager_firm(); v_old text;
BEGIN
  SELECT stripe_customer_id INTO v_old FROM huis.firms WHERE id = v_firm FOR UPDATE;
  IF v_old IS NOT NULL THEN
    IF v_old = p_customer THEN RETURN; END IF;
    RAISE EXCEPTION 'This firm already has a billing account' USING ERRCODE = '42501';
  END IF;
  UPDATE huis.firms SET stripe_customer_id = p_customer WHERE id = v_firm;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, huis.current_user_id(), 'billing.account_created', 'firm', v_firm, '{}'::jsonb);
END $$;
ALTER FUNCTION huis.my_firm_set_stripe_customer(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_set_stripe_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_set_stripe_customer(text) TO huis_app;

-- ---------------------------------------------------------------------------
-- Stripe's notifications (huis_billing only). The webhook passes the subscription's CURRENT state, as just
-- fetched from Stripe, never the copy inside the notification.
-- Returns 'applied', 'unchanged', or 'ignored: <why>'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.billing_apply_subscription(
  p_firm_id uuid, p_customer text, p_subscription text, p_status text, p_interval text,
  p_period_end timestamptz, p_known_price boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f huis.firms;
  v_live boolean := p_status IN ('active', 'trialing', 'past_due');
  v_ended boolean := p_status IN ('canceled', 'unpaid', 'incomplete_expired', 'paused');
  v_new_end timestamptz;
BEGIN
  IF p_subscription IS NULL OR p_subscription !~ '^sub_[A-Za-z0-9]{1,255}$' THEN RETURN 'ignored: subscription id'; END IF;
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignored: firm not found'; END IF;
  -- Only the customer this firm opened checkout with (recorded by the app).
  IF f.stripe_customer_id IS NULL OR f.stripe_customer_id <> p_customer THEN RETURN 'ignored: customer does not match'; END IF;

  IF v_live THEN
    -- A subscription to anything but the two Huis prices never grants access.
    IF NOT p_known_price OR p_interval IS NULL OR p_interval NOT IN ('month', 'year') THEN RETURN 'ignored: unknown price'; END IF;
    IF p_period_end IS NULL THEN RETURN 'ignored: no period end'; END IF;
    IF f.plan = 'professional' AND f.seat_limit IS NULL AND f.paid_through IS NOT DISTINCT FROM p_period_end
       AND f.stripe_subscription_id = p_subscription AND f.stripe_status = p_status
       AND f.billing_interval = p_interval AND f.access_ended_at IS NULL THEN
      RETURN 'unchanged';
    END IF;
    UPDATE huis.firms SET plan = 'professional', seat_limit = NULL, paid_through = p_period_end,
           stripe_subscription_id = p_subscription, stripe_status = p_status, billing_interval = p_interval,
           access_ended_at = NULL
     WHERE id = p_firm_id;
  ELSIF v_ended THEN
    -- An old subscription ending doesn't end the firm's current one.
    IF f.stripe_subscription_id IS NOT NULL AND f.stripe_subscription_id <> p_subscription THEN
      RETURN 'ignored: not the firm''s current subscription';
    END IF;
    -- Never subscribed (checkout abandoned): nothing to end; the trial goes on as before.
    IF f.plan = 'trial' THEN RETURN 'ignored: firm is on the trial'; END IF;
    IF f.stripe_status = p_status AND f.access_ended_at IS NOT NULL THEN RETURN 'unchanged'; END IF;
    v_new_end := coalesce(f.access_ended_at, now());
    UPDATE huis.firms SET stripe_subscription_id = p_subscription, stripe_status = p_status, access_ended_at = v_new_end
     WHERE id = p_firm_id;
  ELSE
    -- 'incomplete': the first payment hasn't gone through. Nothing changes until it does.
    RETURN 'ignored: not started';
  END IF;

  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object(
      'by', 'Stripe',
      'from', jsonb_build_object('plan', f.plan, 'status', f.stripe_status, 'interval', f.billing_interval, 'paid_through', f.paid_through, 'access_ended_at', f.access_ended_at),
      'to', jsonb_build_object('plan', CASE WHEN v_live THEN 'professional' ELSE f.plan END, 'status', p_status,
                               'interval', CASE WHEN v_live THEN p_interval ELSE f.billing_interval END,
                               'paid_through', CASE WHEN v_live THEN p_period_end ELSE f.paid_through END,
                               'access_ended_at', CASE WHEN v_live THEN NULL ELSE v_new_end END)));
  RETURN 'applied';
END $$;
ALTER FUNCTION huis.billing_apply_subscription(uuid, text, text, text, text, timestamptz, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.billing_apply_subscription(uuid, text, text, text, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.billing_apply_subscription(uuid, text, text, text, text, timestamptz, boolean) TO huis_billing;

-- How many seats to bill, for keeping Stripe's quantity in step (huis_billing only; numbers only).
CREATE FUNCTION huis.billing_firm_seats(p_firm_id uuid,
  OUT seats_used int, OUT stripe_customer_id text, OUT stripe_subscription_id text, OUT live boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.firm_seats_used(f.id), f.stripe_customer_id, f.stripe_subscription_id,
         f.plan <> 'trial' AND f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL
    FROM huis.firms f WHERE f.id = p_firm_id
$$;
ALTER FUNCTION huis.billing_firm_seats(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.billing_firm_seats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.billing_firm_seats(uuid) TO huis_billing;
