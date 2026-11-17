-- Phase 10 part 1: subscriptions, the 7-day trial, seats and usage.
--
-- Decisions #35 and #36: a free 7-day trial, then $237 a month per user; enterprise pricing for firms.
-- The trial is limited so nobody can load a whole discovery set for free (source spec, Phase 10).
--
-- What's enforced here, in the database, whatever the caller:
--   * Seats: active attorney and staff licenses can't exceed the firm's seats. Clients, co-counsel and
--     experts (external licenses) don't take a seat.
--   * Trial limits: storage, and AI questions per month.
--   * When the trial has ended, the account is suspended, or payment is more than 7 days overdue, new work
--     (Matters, evidence, AI questions, imports, people) is paused. Nothing is ever deleted or hidden: the
--     firm owns its data (decision #37) and can always open and export it.
--
-- Plans, seats and payment dates are set only by Huis (operator_set_subscription, no app access), until a
-- payment processor is chosen (open item O-11).

CREATE TABLE huis.plans (
  code                    text PRIMARY KEY CHECK (code IN ('trial', 'professional', 'enterprise')),
  name                    text NOT NULL,
  -- Price per seat per month, in cents (null: priced per agreement).
  price_cents_per_seat    int CHECK (price_cents_per_seat IS NULL OR price_cents_per_seat >= 0),
  -- Limits (null: no limit beyond the firm's purchased seats).
  seat_limit              int CHECK (seat_limit IS NULL OR seat_limit >= 1),
  storage_limit_bytes     bigint CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 0),
  ai_questions_per_month  int CHECK (ai_questions_per_month IS NULL OR ai_questions_per_month >= 0)
);
INSERT INTO huis.plans (code, name, price_cents_per_seat, seat_limit, storage_limit_bytes, ai_questions_per_month) VALUES
  ('trial', '7-day free trial', 0, 3, 2::bigint * 1024 * 1024 * 1024, 100),
  ('professional', 'Professional', 23700, NULL, NULL, NULL),
  ('enterprise', 'Enterprise', NULL, NULL, NULL, NULL);
GRANT SELECT ON huis.plans TO huis_app, huis_security;

ALTER TABLE huis.firms
  ADD COLUMN seat_limit int CHECK (seat_limit IS NULL OR seat_limit >= 1),
  ADD COLUMN paid_through timestamptz,
  ADD CONSTRAINT firms_plan_known FOREIGN KEY (plan) REFERENCES huis.plans(code);

-- The new columns are Huis's to set, like the plan and trial (0004's guard covers those).
CREATE FUNCTION huis.firms_subscription_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'huis_security' AND (
       NEW.seat_limit IS DISTINCT FROM OLD.seat_limit OR NEW.paid_through IS DISTINCT FROM OLD.paid_through) THEN
    RAISE EXCEPTION 'Plan, trial and account status are managed by Huis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER firms_subscription_guard BEFORE UPDATE ON huis.firms
  FOR EACH ROW EXECUTE FUNCTION huis.firms_subscription_guard();

-- ---------------------------------------------------------------------------
-- Why new work is paused for a firm, or null when it isn't. Says nothing else about the firm.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.firm_write_block(p_firm_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN f.id IS NULL THEN 'This firm was not found.'
    WHEN f.status <> 'active' THEN
      'This firm''s Huis account is suspended. You can still open and export your work; contact Huis to restore it.'
    WHEN f.plan = 'trial' AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now()) THEN
      'The firm''s free trial has ended. You can still open and export everything; adding new work is paused until the firm subscribes.'
    WHEN f.plan <> 'trial' AND f.paid_through IS NOT NULL AND f.paid_through + interval '7 days' <= now() THEN
      'The firm''s subscription payment is overdue. You can still open and export everything; adding new work is paused until it is paid.'
  END
  FROM (SELECT p_firm_id AS id) want LEFT JOIN huis.firms f ON f.id = want.id
$$;
ALTER FUNCTION huis.firm_write_block(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_write_block(uuid) FROM PUBLIC;
-- The app asks only about its own firm (another firm's standing is none of its business).
CREATE FUNCTION huis.my_firm_write_block() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE WHEN huis.current_firm_id() IS NULL THEN NULL ELSE huis.firm_write_block(huis.current_firm_id()) END
$$;
ALTER FUNCTION huis.my_firm_write_block() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_write_block() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_write_block() TO huis_app;

-- The limits that apply to a firm now (its own seats first, then the plan's).
CREATE FUNCTION huis.firm_limits(p_firm_id uuid,
  OUT plan text, OUT seat_limit int, OUT storage_limit_bytes bigint, OUT ai_questions_per_month int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.plan, coalesce(f.seat_limit, p.seat_limit), p.storage_limit_bytes, p.ai_questions_per_month
    FROM huis.firms f JOIN huis.plans p ON p.code = f.plan WHERE f.id = p_firm_id
$$;
ALTER FUNCTION huis.firm_limits(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_limits(uuid) FROM PUBLIC;

-- Counted across the whole firm (walled Matters included), so these run as huis_security.
CREATE FUNCTION huis.firm_seats_used(p_firm_id uuid, p_except uuid DEFAULT NULL) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT count(*)::int FROM huis.licenses l
   WHERE l.firm_id = p_firm_id AND l.status = 'active' AND l.kind IN ('attorney', 'staff')
     AND (p_except IS NULL OR l.id <> p_except)
$$;
CREATE FUNCTION huis.firm_storage_used(p_firm_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce(sum(size_bytes), 0)::bigint FROM huis.evidence_items WHERE firm_id = p_firm_id
$$;
-- AI questions asked this calendar month (UTC): Matter Brain questions and agent questions.
CREATE FUNCTION huis.firm_ai_questions_this_month(p_firm_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT ((SELECT count(*) FROM huis.brain_answers WHERE firm_id = p_firm_id
             AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        + (SELECT count(*) FROM huis.ai_agent_turns WHERE firm_id = p_firm_id
             AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::int
$$;
ALTER FUNCTION huis.firm_seats_used(uuid, uuid) OWNER TO huis_security;
ALTER FUNCTION huis.firm_storage_used(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.firm_ai_questions_this_month(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_seats_used(uuid, uuid), huis.firm_storage_used(uuid), huis.firm_ai_questions_this_month(uuid) FROM PUBLIC;
GRANT SELECT ON huis.licenses, huis.brain_answers, huis.ai_agent_turns, huis.evidence_items, huis.firms TO huis_security;

-- Counting and inserting must happen one at a time per firm, or two requests could both take the last seat.
CREATE FUNCTION huis.lock_firm_usage(p_firm_id uuid) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('huis.firm_usage:' || p_firm_id::text, 0)) $$;

-- The checks below run as huis_security (they count across the whole firm). A row for a firm other than the
-- caller's is left to row-level security to refuse, so these never say anything about another firm.
-- Their errors use SQLSTATE HU402; the app shows the message as written.
CREATE FUNCTION huis.usage_check_applies(p_firm_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT huis.current_firm_id() IS NULL OR huis.current_firm_id() = p_firm_id
$$;

-- New work needs an account in good standing.
CREATE FUNCTION huis.require_active_subscription() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  -- What's derived from work already received (a container's files, a working copy) is finished.
  -- (Nested: NEW.parent_id exists only on evidence_items.)
  IF TG_TABLE_NAME = 'evidence_items' THEN
    IF NEW.parent_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  v_block := huis.firm_write_block(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matters_subscription BEFORE INSERT ON huis.matters
  FOR EACH ROW EXECUTE FUNCTION huis.require_active_subscription();
CREATE TRIGGER evidence_items_subscription BEFORE INSERT ON huis.evidence_items
  FOR EACH ROW EXECUTE FUNCTION huis.require_active_subscription();
CREATE TRIGGER ai_conversations_subscription BEFORE INSERT ON huis.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION huis.require_active_subscription();
CREATE TRIGGER integration_imports_subscription BEFORE INSERT ON huis.integration_imports
  FOR EACH ROW EXECUTE FUNCTION huis.require_active_subscription();

-- Seats: an attorney or staff license becoming active takes one.
CREATE FUNCTION huis.license_seat_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit int; v_used int;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  IF NEW.status <> 'active' OR NEW.kind NOT IN ('attorney', 'staff') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.kind IN ('attorney', 'staff') AND OLD.firm_id = NEW.firm_id THEN
    RETURN NEW;
  END IF;
  v_block := huis.firm_write_block(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  v_limit := (huis.firm_limits(NEW.firm_id)).seat_limit;
  IF v_limit IS NOT NULL THEN
    v_used := huis.firm_seats_used(NEW.firm_id, NEW.id);
    IF v_used + 1 > v_limit THEN
      RAISE EXCEPTION 'All % of the firm''s seats are in use. Disable someone''s access first, or ask Huis to add seats. (Clients, co-counsel and experts don''t take a seat.)', v_limit
        USING ERRCODE = 'HU402';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER licenses_seat_check BEFORE INSERT OR UPDATE OF status, kind ON huis.licenses
  FOR EACH ROW EXECUTE FUNCTION huis.license_seat_check();

-- Storage: a new upload or import must fit (derived files of work already received always finish).
CREATE FUNCTION huis.evidence_storage_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_limit bigint;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) OR NEW.parent_id IS NOT NULL THEN RETURN NEW; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).storage_limit_bytes;
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  IF huis.firm_storage_used(NEW.firm_id) + coalesce(NEW.size_bytes, 0) > v_limit THEN
    RAISE EXCEPTION 'This would go past the trial''s storage limit (% GB). Subscribe to add more evidence.', round(v_limit / 1073741824.0, 1)
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;
-- Named to run after evidence_items_subscription (triggers fire in name order).
CREATE TRIGGER evidence_items_subscription_storage BEFORE INSERT ON huis.evidence_items
  FOR EACH ROW EXECUTE FUNCTION huis.evidence_storage_check();

-- An upload is checked when it starts too, so nobody sends gigabytes only to be refused at the end.
-- (The check on evidence_items above is still what counts: several uploads can start together.)
CREATE FUNCTION huis.upload_start_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit bigint;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_block := huis.firm_write_block(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).storage_limit_bytes;
  IF v_limit IS NOT NULL AND huis.firm_storage_used(NEW.firm_id) + coalesce(NEW.total_size, 0) > v_limit THEN
    RAISE EXCEPTION 'This would go past the trial''s storage limit (% GB). Subscribe to add more evidence.', round(v_limit / 1073741824.0, 1)
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION huis.upload_start_check() OWNER TO huis_security;
CREATE TRIGGER upload_sessions_subscription BEFORE INSERT ON huis.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION huis.upload_start_check();

-- AI questions: needs an account in good standing, and fits the month's allowance.
CREATE FUNCTION huis.ai_question_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit int;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_block := huis.firm_write_block(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).ai_questions_per_month;
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  IF huis.firm_ai_questions_this_month(NEW.firm_id) + 1 > v_limit THEN
    RAISE EXCEPTION 'The firm has used this month''s % AI questions on the trial. Subscribe to keep asking.', v_limit
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION huis.require_active_subscription() OWNER TO huis_security;
ALTER FUNCTION huis.license_seat_check() OWNER TO huis_security;
ALTER FUNCTION huis.evidence_storage_check() OWNER TO huis_security;
ALTER FUNCTION huis.ai_question_check() OWNER TO huis_security;
GRANT EXECUTE ON FUNCTION huis.lock_firm_usage(uuid) TO huis_security;

CREATE TRIGGER brain_answers_subscription BEFORE INSERT ON huis.brain_answers
  FOR EACH ROW EXECUTE FUNCTION huis.ai_question_check();
CREATE TRIGGER ai_agent_turns_subscription BEFORE INSERT ON huis.ai_agent_turns
  FOR EACH ROW EXECUTE FUNCTION huis.ai_question_check();

-- ---------------------------------------------------------------------------
-- The firm's subscription and usage, for the people who manage the account (numbers only).
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.my_firm_subscription(
  OUT plan text, OUT plan_name text, OUT price_cents_per_seat int, OUT trial_ends_at timestamptz, OUT paid_through timestamptz,
  OUT seat_limit int, OUT seats_used int, OUT external_users int,
  OUT storage_limit_bytes bigint, OUT storage_used_bytes bigint,
  OUT ai_questions_per_month int, OUT ai_questions_used int, OUT write_block text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); l record;
BEGIN
  IF v_firm IS NULL OR huis.app_role()::text NOT IN ('firm_owner', 'managing_partner', 'firm_admin', 'billing_admin') THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM huis.firm_limits(v_firm);
  SELECT f.plan, p.name, p.price_cents_per_seat, f.trial_ends_at, f.paid_through
    INTO plan, plan_name, price_cents_per_seat, trial_ends_at, paid_through
    FROM huis.firms f JOIN huis.plans p ON p.code = f.plan WHERE f.id = v_firm;
  seat_limit := l.seat_limit;
  seats_used := huis.firm_seats_used(v_firm);
  external_users := (SELECT count(*)::int FROM huis.licenses x WHERE x.firm_id = v_firm AND x.status = 'active' AND x.kind = 'external');
  storage_limit_bytes := l.storage_limit_bytes;
  storage_used_bytes := huis.firm_storage_used(v_firm);
  ai_questions_per_month := l.ai_questions_per_month;
  ai_questions_used := huis.firm_ai_questions_this_month(v_firm);
  write_block := huis.firm_write_block(v_firm);
END $$;
ALTER FUNCTION huis.my_firm_subscription() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_subscription() TO huis_app;

-- ---------------------------------------------------------------------------
-- Huis staff only: change a firm's plan, seats and dates (no app or worker access; run from
-- scripts/operator with the database owner's connection). Recorded in the firm's audit log.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.operator_set_subscription(
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
         paid_through = p_paid_through, status = p_status
   WHERE id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'subscription.changed', 'firm', p_firm_id, jsonb_build_object(
      'by', 'Huis', 'note', nullif(p_note, ''),
      'from', jsonb_build_object('plan', o.plan, 'seats', o.seat_limit, 'trial_ends_at', o.trial_ends_at, 'paid_through', o.paid_through, 'status', o.status),
      'to', jsonb_build_object('plan', p_plan, 'seats', p_seat_limit, 'trial_ends_at', p_trial_ends_at, 'paid_through', p_paid_through, 'status', p_status)));
END $$;
ALTER FUNCTION huis.operator_set_subscription(uuid, text, int, timestamptz, timestamptz, huis.record_status, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.operator_set_subscription(uuid, text, int, timestamptz, timestamptz, huis.record_status, text) FROM PUBLIC;
GRANT UPDATE ON huis.firms TO huis_security;
GRANT SELECT, INSERT ON huis.audit_events TO huis_security;
GRANT USAGE ON SEQUENCE huis.audit_events_id_seq TO huis_security;
