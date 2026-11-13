-- Security review 30 (Phase 10 part 6, the Huis admin portal).
--
-- R30-1: a trial end in the past was accepted, giving the firm a deletion date that had already passed (no
--        warnings). A trial end must now be in the future, and a firm with a live Stripe subscription keeps
--        Stripe's dates: change the trial in Stripe instead.
-- R30-2: "plan by agreement" was allowed while Stripe could still restart a subscription (unpaid, paused,
--        incomplete). It is now refused whenever a Stripe subscription exists that is not finished
--        (canceled or incomplete_expired).
-- Also: staff notes no longer block deleting a firm (firm_id is cleared when the firm row goes), and
--       huis.lock_firm_usage is no longer callable by every role through the default PUBLIC grant.

CREATE FUNCTION huis.platform_stripe_live(f huis.firms) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT f.stripe_subscription_id IS NOT NULL AND coalesce(f.stripe_status, '') NOT IN ('canceled', 'incomplete_expired')
$$;
REVOKE ALL ON FUNCTION huis.platform_stripe_live(huis.firms) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.platform_stripe_live(huis.firms) TO huis_security;

CREATE OR REPLACE FUNCTION huis.platform_set_trial_end(p_staff text, p_firm_id uuid, p_trial_ends timestamptz, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE f huis.firms;
BEGIN
  PERFORM huis.platform_check_note(p_staff, p_note);
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'firm not found'; END IF;
  IF f.plan <> 'trial' THEN RAISE EXCEPTION 'This firm is not on the trial.' USING ERRCODE = 'HU400'; END IF;
  IF huis.platform_stripe_live(f) THEN
    RAISE EXCEPTION 'This firm has a Stripe subscription. Change its trial in Stripe instead.' USING ERRCODE = 'HU400';
  END IF;
  IF p_trial_ends IS NULL OR p_trial_ends <= now() OR p_trial_ends > now() + interval '90 days' THEN
    RAISE EXCEPTION 'Choose a trial end in the future, within the next 90 days.' USING ERRCODE = 'HU400';
  END IF;
  UPDATE huis.firms SET trial_ends_at = p_trial_ends WHERE id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object('by', 'Huis', 'note', p_note,
      'from', jsonb_build_object('trial_ends_at', f.trial_ends_at), 'to', jsonb_build_object('trial_ends_at', p_trial_ends)));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'trial.set_end', p_firm_id, p_note, jsonb_build_object('from', f.trial_ends_at, 'to', p_trial_ends));
END $$;

CREATE OR REPLACE FUNCTION huis.platform_set_agreement(p_staff text, p_firm_id uuid, p_plan text, p_seats int, p_paid_through timestamptz, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE f huis.firms;
BEGIN
  PERFORM huis.platform_check_note(p_staff, p_note);
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'firm not found'; END IF;
  IF p_plan NOT IN ('professional', 'enterprise') THEN RAISE EXCEPTION 'Choose professional or enterprise.' USING ERRCODE = 'HU400'; END IF;
  IF p_seats IS NOT NULL AND (p_seats < 1 OR p_seats > 10000) THEN RAISE EXCEPTION 'Seats must be between 1 and 10,000.' USING ERRCODE = 'HU400'; END IF;
  IF p_paid_through IS NULL OR p_paid_through < now() - interval '1 day' OR p_paid_through > now() + interval '3 years' THEN
    RAISE EXCEPTION 'Choose a paid-through date within the next 3 years.' USING ERRCODE = 'HU400';
  END IF;
  IF huis.platform_stripe_live(f) THEN
    RAISE EXCEPTION 'This firm has a Stripe subscription that could still charge. Cancel it in Stripe first.' USING ERRCODE = 'HU400';
  END IF;
  PERFORM huis.operator_set_subscription(p_firm_id, p_plan, p_seats, f.trial_ends_at, p_paid_through, f.status, left(p_staff || ': ' || p_note, 500));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'plan.set_agreement', p_firm_id, p_note,
            jsonb_build_object('from', jsonb_build_object('plan', f.plan, 'seats', f.seat_limit, 'paid_through', f.paid_through),
                               'to', jsonb_build_object('plan', p_plan, 'seats', p_seats, 'paid_through', p_paid_through)));
END $$;

-- Staff notes must not stop a firm from being deleted (part 2b). The note rows stay, without the firm link.
-- Part 2b decides whether notes about a deleted firm are kept; they hold account remarks, never client content.
ALTER TABLE huis.platform_audit DROP CONSTRAINT platform_audit_firm_id_fkey;
ALTER TABLE huis.platform_audit ADD CONSTRAINT platform_audit_firm_id_fkey
  FOREIGN KEY (firm_id) REFERENCES huis.firms(id) ON DELETE SET NULL;

REVOKE ALL ON FUNCTION huis.lock_firm_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.lock_firm_usage(uuid) TO huis_security;
