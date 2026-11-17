-- Security review 27 (Phase 10 part 2a: Stripe, the trial, the 30-day deletion date).
--
-- R27-1: subscribing during the trial lifted the 1-seat / 1-Matter limits at once, though Stripe charges
--        nothing until the trial ends and the firm could cancel first. A 'trialing' subscription is now recorded
--        but the firm stays on the trial, with its limits, until Stripe reports the first payment ('active').
-- R27-2: a failed renewal ('past_due') moved the paid-through date to the end of the unpaid period, so the
--        7 days' grace never ran out. Only a paid ('active') subscription moves it forward now.
-- R27-3: when Huis set a firm's plan by hand (e.g. invoiced by agreement), its ended Stripe state stayed, so a
--        paying firm was still paused and shown a deletion date. operator_set_subscription now clears it, and
--        Stripe can't end access for a firm that has no current Stripe subscription.
-- R27-4: clients and other outside users could read the firm's Stripe standing from huis.firms. The app may
--        now read only the firm's non-billing columns; billing state goes through the my_firm_* functions.
-- Also (unconfirmed concerns in the review, closed here): a second subscription completed while the first is
-- live no longer replaces it; an abandoned checkout ('incomplete_expired') never ends access.

CREATE OR REPLACE FUNCTION huis.billing_apply_subscription(
  p_firm_id uuid, p_customer text, p_subscription text, p_status text, p_interval text,
  p_period_end timestamptz, p_known_price boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f huis.firms;
  v_live boolean := p_status IN ('active', 'trialing', 'past_due');
  v_ended boolean := p_status IN ('canceled', 'unpaid', 'paused');
  v_plan text; v_paid timestamptz; v_ended_at timestamptz;
BEGIN
  IF p_subscription IS NULL OR p_subscription !~ '^sub_[A-Za-z0-9]{1,255}$' THEN RETURN 'ignored: subscription id'; END IF;
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignored: firm not found'; END IF;
  IF f.stripe_customer_id IS NULL OR f.stripe_customer_id <> p_customer THEN RETURN 'ignored: customer does not match'; END IF;

  IF v_live THEN
    IF NOT p_known_price OR p_interval IS NULL OR p_interval NOT IN ('month', 'year') THEN RETURN 'ignored: unknown price'; END IF;
    IF p_period_end IS NULL THEN RETURN 'ignored: no period end'; END IF;
    -- A second subscription while the firm's current one is live doesn't replace it (double checkout).
    IF f.stripe_subscription_id IS NOT NULL AND f.stripe_subscription_id <> p_subscription
       AND f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL THEN
      RETURN 'ignored: firm already has a subscription';
    END IF;
    IF p_status = 'active' THEN
      -- Paid: the firm is a paying firm, through the paid period.
      v_plan := 'professional'; v_paid := p_period_end;
    ELSIF f.plan = 'trial' THEN
      -- R27-1: trialing (nothing paid yet), or the first payment failed: still the trial, with its limits.
      v_plan := 'trial'; v_paid := f.paid_through;
    ELSE
      -- R27-2: past_due (or trialing again) on a paying firm: access runs from what was paid, plus the grace.
      v_plan := f.plan; v_paid := coalesce(f.paid_through, p_period_end);
    END IF;
    IF f.plan = v_plan AND f.paid_through IS NOT DISTINCT FROM v_paid AND f.stripe_subscription_id = p_subscription
       AND f.stripe_status = p_status AND f.billing_interval = p_interval AND f.access_ended_at IS NULL
       AND (v_plan = 'trial' OR f.seat_limit IS NULL) THEN
      RETURN 'unchanged';
    END IF;
    UPDATE huis.firms SET plan = v_plan, paid_through = v_paid,
           seat_limit = CASE WHEN v_plan = 'trial' THEN f.seat_limit ELSE NULL END,
           stripe_subscription_id = p_subscription, stripe_status = p_status, billing_interval = p_interval,
           access_ended_at = NULL
     WHERE id = p_firm_id;
  ELSIF v_ended THEN
    -- Only the firm's current Stripe subscription can end its access (not an old one, and not for a firm
    -- whose plan Huis set by hand).
    IF f.stripe_subscription_id IS DISTINCT FROM p_subscription THEN
      RETURN 'ignored: not the firm''s current subscription';
    END IF;
    IF f.stripe_status = p_status THEN RETURN 'unchanged'; END IF;
    v_plan := f.plan; v_paid := f.paid_through;
    -- Cancelled during the trial: the trial's own end date governs, as if they had never subscribed.
    v_ended_at := CASE WHEN f.plan = 'trial' THEN NULL ELSE coalesce(f.access_ended_at, now()) END;
    UPDATE huis.firms SET stripe_status = p_status, access_ended_at = v_ended_at WHERE id = p_firm_id;
  ELSE
    -- 'incomplete' / 'incomplete_expired': the first payment never went through. Nothing changes.
    RETURN 'ignored: not started';
  END IF;

  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object(
      'by', 'Stripe',
      'from', jsonb_build_object('plan', f.plan, 'status', f.stripe_status, 'interval', f.billing_interval, 'paid_through', f.paid_through, 'access_ended_at', f.access_ended_at),
      'to', jsonb_build_object('plan', v_plan, 'status', p_status,
                               'interval', CASE WHEN v_live THEN p_interval ELSE f.billing_interval END,
                               'paid_through', v_paid,
                               'access_ended_at', CASE WHEN v_live THEN NULL ELSE v_ended_at END)));
  RETURN 'applied';
END $$;

-- Seats are billed while a subscription is live, on the trial too (it bills from the trial's end).
CREATE OR REPLACE FUNCTION huis.billing_firm_seats(p_firm_id uuid,
  OUT seats_used int, OUT stripe_customer_id text, OUT stripe_subscription_id text, OUT live boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.firm_seats_used(f.id), f.stripe_customer_id, f.stripe_subscription_id,
         f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL
    FROM huis.firms f WHERE f.id = p_firm_id
$$;

-- A firm that has a live Stripe subscription (trialing included) can't open another checkout.
CREATE OR REPLACE FUNCTION huis.my_firm_checkout(
  OUT firm_id uuid, OUT firm_name text, OUT stripe_customer_id text, OUT seats_used int,
  OUT trial_ends_at timestamptz, OUT subscribed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.billing_manager_firm();
BEGIN
  SELECT f.id, f.name, f.stripe_customer_id, huis.firm_seats_used(f.id),
         CASE WHEN f.plan = 'trial' THEN f.trial_ends_at END,
         f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL
    INTO firm_id, firm_name, stripe_customer_id, seats_used, trial_ends_at, subscribed
    FROM huis.firms f WHERE f.id = v_firm;
END $$;

-- R27-3: Huis setting a firm's plan by hand clears any Stripe subscription state (the customer is kept, so the
-- firm can subscribe online again later).
CREATE OR REPLACE FUNCTION huis.operator_set_subscription(
  p_firm_id uuid, p_plan text, p_seat_limit int, p_trial_ends_at timestamptz, p_paid_through timestamptz,
  p_status huis.record_status, p_note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE o huis.firms;
BEGIN
  SELECT * INTO o FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'firm not found'; END IF;
  IF p_plan = 'trial' AND p_trial_ends_at IS NULL THEN RAISE EXCEPTION 'a trial needs an end date'; END IF;
  IF length(coalesce(p_note, '')) > 500 THEN RAISE EXCEPTION 'note too long'; END IF;
  UPDATE huis.firms SET plan = p_plan, seat_limit = p_seat_limit, trial_ends_at = p_trial_ends_at,
         paid_through = p_paid_through, status = p_status,
         stripe_subscription_id = NULL, stripe_status = NULL, billing_interval = NULL, access_ended_at = NULL
   WHERE id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object(
      'by', 'Huis', 'note', nullif(p_note, ''),
      'from', jsonb_build_object('plan', o.plan, 'seats', o.seat_limit, 'trial_ends_at', o.trial_ends_at, 'paid_through', o.paid_through,
                                 'status', o.status, 'stripe_status', o.stripe_status, 'access_ended_at', o.access_ended_at),
      'to', jsonb_build_object('plan', p_plan, 'seats', p_seat_limit, 'trial_ends_at', p_trial_ends_at, 'paid_through', p_paid_through, 'status', p_status)));
END $$;

-- R27-4: the app reads the firm's non-billing columns only. (Built from the table so a later column isn't
-- silently hidden; the billing columns are named here and stay out.)
DO $$
DECLARE v_cols text;
BEGIN
  REVOKE SELECT ON huis.firms FROM huis_app;
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'huis.firms'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('stripe_customer_id', 'stripe_subscription_id', 'stripe_status', 'billing_interval',
                         'access_ended_at', 'paid_through', 'seat_limit');
  EXECUTE format('GRANT SELECT (%s) ON huis.firms TO huis_app', v_cols);
END $$;
