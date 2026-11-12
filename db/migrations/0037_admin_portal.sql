-- Phase 10 part 6: the Huis admin portal (replaces the operator command for day-to-day account work).
--
-- The rule: Huis staff see ACCOUNT information only (the firm's name, owner contact, plan, trial and payment
-- dates, seats and usage counts, Stripe status, the deletion date) and NEVER a Matter, a document, evidence,
-- an email, a note or anything else a firm keeps for its clients. Attorney-client privilege comes first.
--
-- How the database enforces it: the portal's login is a member of huis_platform, which has no rights on any
-- table and can call only the platform_* functions below. Each returns counts and account fields, never
-- client content. Every change a staff member makes is written to huis.platform_audit (which can only be
-- added to) and to the firm's own audit log, with the staff member's name and a required note.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huis_platform') THEN
    CREATE ROLE huis_platform NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA huis TO huis_platform;

CREATE TABLE huis.platform_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  staff       text NOT NULL CHECK (length(staff) BETWEEN 1 AND 300),
  action      text NOT NULL CHECK (action ~ '^[a-z_.]{1,60}$'),
  firm_id     uuid REFERENCES huis.firms(id),
  note        text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX platform_audit_firm ON huis.platform_audit (firm_id, at DESC);
REVOKE ALL ON huis.platform_audit FROM PUBLIC;
GRANT SELECT, INSERT ON huis.platform_audit TO huis_security;
GRANT USAGE ON SEQUENCE huis.platform_audit_id_seq TO huis_security;

-- One row per firm: account fields and counts only.
CREATE FUNCTION huis.platform_firm_rows(p_firm_id uuid, p_search text)
RETURNS TABLE (
  firm_id uuid, name text, slug text, state_code text, created_at timestamptz, status text, plan text,
  trial_ends_at timestamptz, paid_through timestamptz, seat_limit int, seats_used int, external_users int,
  matters int, storage_bytes bigint, ai_questions int, stripe_status text, billing_interval text,
  has_stripe_customer boolean, first_paid_at timestamptz, access_ended_at timestamptz, delete_after timestamptz,
  write_block text, owner_name text, owner_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.id, f.name, f.slug, f.state_code, f.created_at, f.status::text, f.plan,
         f.trial_ends_at, f.paid_through, (huis.firm_limits(f.id)).seat_limit, huis.firm_seats_used(f.id),
         (SELECT count(*)::int FROM huis.licenses x WHERE x.firm_id = f.id AND x.status = 'active' AND x.kind = 'external'),
         huis.firm_matters_used(f.id), huis.firm_storage_used(f.id), huis.firm_ai_questions_this_month(f.id),
         f.stripe_status, f.billing_interval, f.stripe_customer_id IS NOT NULL, f.first_paid_at,
         huis.firm_access_ended_at(f.id), huis.firm_delete_after(f.id), huis.firm_write_block(f.id),
         o.full_name, o.email
    FROM huis.firms f
    LEFT JOIN LATERAL (SELECT u.full_name, u.email FROM huis.users u
                        WHERE u.firm_id = f.id AND u.role = 'firm_owner' ORDER BY u.created_at LIMIT 1) o ON true
   WHERE (p_firm_id IS NULL OR f.id = p_firm_id)
     AND (p_search IS NULL OR btrim(p_search) = ''
          OR f.name ILIKE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          OR f.slug ILIKE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          OR o.email ILIKE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%')
   ORDER BY f.created_at DESC
   LIMIT 500
$$;
ALTER FUNCTION huis.platform_firm_rows(uuid, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.platform_firm_rows(uuid, text) FROM PUBLIC;
GRANT SELECT ON huis.users, huis.licenses TO huis_security;

GRANT EXECUTE ON FUNCTION huis.platform_firm_rows(uuid, text) TO huis_platform;

-- The firm's account history (plan changes, billing, staff actions): what changed and when, never client content.
CREATE FUNCTION huis.platform_firm_history(p_firm_id uuid)
RETURNS TABLE (at timestamptz, source text, action text, by_whom text, note text, detail jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT * FROM (
    SELECT a.occurred_at, 'firm'::text, a.action, coalesce(a.metadata->>'by', 'Firm'), a.metadata->>'note',
           jsonb_strip_nulls(jsonb_build_object('from', a.metadata->'from', 'to', a.metadata->'to'))
      FROM huis.audit_events a
     WHERE a.firm_id = p_firm_id AND a.action IN ('subscription.changed', 'billing.account_created')
    UNION ALL
    SELECT p.at, 'huis', p.action, p.staff, p.note, p.detail FROM huis.platform_audit p WHERE p.firm_id = p_firm_id
  ) h ORDER BY 1 DESC LIMIT 100
$$;
ALTER FUNCTION huis.platform_firm_history(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.platform_firm_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.platform_firm_history(uuid) TO huis_platform;
GRANT SELECT ON huis.audit_events TO huis_security;

CREATE FUNCTION huis.platform_check_note(p_staff text, p_note text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF length(btrim(coalesce(p_staff, ''))) = 0 OR length(p_staff) > 300 THEN RAISE EXCEPTION 'staff name required'; END IF;
  IF length(btrim(coalesce(p_note, ''))) = 0 THEN RAISE EXCEPTION 'A note is required (why this change is being made).' USING ERRCODE = 'HU400'; END IF;
  IF length(p_note) > 500 THEN RAISE EXCEPTION 'Keep the note under 500 characters.' USING ERRCODE = 'HU400'; END IF;
END $$;

-- Extend (or shorten) a trial. Only for a firm on the trial; touches nothing else (a Stripe subscription, if
-- any, keeps its own dates).
CREATE FUNCTION huis.platform_set_trial_end(p_staff text, p_firm_id uuid, p_trial_ends timestamptz, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE f huis.firms;
BEGIN
  PERFORM huis.platform_check_note(p_staff, p_note);
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'firm not found'; END IF;
  IF f.plan <> 'trial' THEN RAISE EXCEPTION 'This firm is not on the trial.' USING ERRCODE = 'HU400'; END IF;
  IF p_trial_ends IS NULL OR p_trial_ends > now() + interval '90 days' THEN
    RAISE EXCEPTION 'Choose a trial end within the next 90 days.' USING ERRCODE = 'HU400';
  END IF;
  UPDATE huis.firms SET trial_ends_at = p_trial_ends WHERE id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object('by', 'Huis', 'note', p_note,
      'from', jsonb_build_object('trial_ends_at', f.trial_ends_at), 'to', jsonb_build_object('trial_ends_at', p_trial_ends)));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'trial.set_end', p_firm_id, p_note, jsonb_build_object('from', f.trial_ends_at, 'to', p_trial_ends));
END $$;

-- Suspend or restore a firm's account. Touches nothing else (its plan and any Stripe subscription stay as they are).
CREATE FUNCTION huis.platform_set_status(p_staff text, p_firm_id uuid, p_status huis.record_status, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE f huis.firms;
BEGIN
  PERFORM huis.platform_check_note(p_staff, p_note);
  SELECT * INTO f FROM huis.firms WHERE id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'firm not found'; END IF;
  IF p_status NOT IN ('active', 'suspended') THEN RAISE EXCEPTION 'Choose active or suspended.' USING ERRCODE = 'HU400'; END IF;
  IF f.status = p_status THEN RETURN; END IF;
  UPDATE huis.firms SET status = p_status WHERE id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object('by', 'Huis', 'note', p_note,
      'from', jsonb_build_object('status', f.status), 'to', jsonb_build_object('status', p_status)));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'firm.set_status', p_firm_id, p_note, jsonb_build_object('from', f.status, 'to', p_status));
END $$;

-- A plan by agreement (professional or enterprise, invoiced outside Stripe): seats and paid-through date.
-- Refused while the firm pays through Stripe, so Huis never stops following a subscription Stripe still charges:
-- change or cancel it in Stripe first.
CREATE FUNCTION huis.platform_set_agreement(p_staff text, p_firm_id uuid, p_plan text, p_seats int, p_paid_through timestamptz, p_note text) RETURNS void
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
  IF f.stripe_status IN ('active', 'trialing', 'past_due') AND f.access_ended_at IS NULL THEN
    RAISE EXCEPTION 'This firm pays through Stripe. Cancel or change its subscription in Stripe first.' USING ERRCODE = 'HU400';
  END IF;
  PERFORM huis.operator_set_subscription(p_firm_id, p_plan, p_seats, f.trial_ends_at, p_paid_through, f.status, left(p_staff || ': ' || p_note, 500));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'plan.set_agreement', p_firm_id, p_note,
            jsonb_build_object('from', jsonb_build_object('plan', f.plan, 'seats', f.seat_limit, 'paid_through', f.paid_through),
                               'to', jsonb_build_object('plan', p_plan, 'seats', p_seats, 'paid_through', p_paid_through)));
END $$;

ALTER FUNCTION huis.platform_set_trial_end(text, uuid, timestamptz, text) OWNER TO huis_security;
ALTER FUNCTION huis.platform_set_status(text, uuid, huis.record_status, text) OWNER TO huis_security;
ALTER FUNCTION huis.platform_set_agreement(text, uuid, text, int, timestamptz, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.platform_set_trial_end(text, uuid, timestamptz, text), huis.platform_set_status(text, uuid, huis.record_status, text),
  huis.platform_set_agreement(text, uuid, text, int, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.platform_set_trial_end(text, uuid, timestamptz, text), huis.platform_set_status(text, uuid, huis.record_status, text),
  huis.platform_set_agreement(text, uuid, text, int, timestamptz, text) TO huis_platform;
