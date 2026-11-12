-- Tracy's decisions of 11 November 2026 on the trial and on deletion.
--
-- 1. Deletion applies only to a trial that ends unpaid: 30 days after the 7-day trial ends, its data is
--    deleted (the deletion itself is part 2b). A firm that has ever paid is never given a deletion date: if
--    its subscription stops, its Matters and information are held, read and export only, until it subscribes
--    again. (The terms of service and privacy policy will say so.)
-- 2. The trial's AI allowance is 100 AI questions for the whole trial, not per calendar month (a trial that
--    crossed a month end got 200). An AI question is one a person asks Matter Brain or an AI agent; work
--    Huis does by itself (reading files, the timeline, suggestions, analysis, scanning a case description)
--    never counts. Storage stays at 2 GB.

-- When the firm first became a paying firm (null: never). Set once, never cleared.
ALTER TABLE huis.firms ADD COLUMN first_paid_at timestamptz;

CREATE OR REPLACE FUNCTION huis.firms_subscription_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'huis_security' AND (
       NEW.seat_limit IS DISTINCT FROM OLD.seat_limit OR NEW.paid_through IS DISTINCT FROM OLD.paid_through
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.stripe_status IS DISTINCT FROM OLD.stripe_status
    OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
    OR NEW.access_ended_at IS DISTINCT FROM OLD.access_ended_at
    OR NEW.first_paid_at IS DISTINCT FROM OLD.first_paid_at) THEN
    RAISE EXCEPTION 'Plan, trial and account status are managed by Huis';
  END IF;
  -- Once a firm has paid, it stays a firm that has paid (whoever changes the plan afterwards).
  IF OLD.first_paid_at IS NOT NULL AND NEW.first_paid_at IS DISTINCT FROM OLD.first_paid_at THEN
    NEW.first_paid_at := OLD.first_paid_at;
  END IF;
  RETURN NEW;
END $$;

-- A firm becomes a paying firm when its plan first leaves the trial: Stripe's first payment ('active'), or
-- Huis setting a paid plan by hand (invoiced by agreement).
CREATE FUNCTION huis.firms_first_paid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan <> 'trial' AND NEW.first_paid_at IS NULL THEN NEW.first_paid_at := now(); END IF;
  RETURN NEW;
END $$;
-- Named to run after firms_subscription_guard (triggers fire in name order).
CREATE TRIGGER firms_zz_first_paid BEFORE INSERT OR UPDATE OF plan ON huis.firms
  FOR EACH ROW EXECUTE FUNCTION huis.firms_first_paid();

-- Firms already on a paid plan have paid.
DO $$
BEGIN
  SET LOCAL ROLE huis_security;
  UPDATE huis.firms SET first_paid_at = created_at WHERE plan <> 'trial' AND first_paid_at IS NULL;
  RESET ROLE;
END $$;

-- Deleted only if the firm never paid and its trial has ended: 30 days after the trial's end.
CREATE OR REPLACE FUNCTION huis.firm_delete_after(p_firm_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.trial_ends_at + interval '30 days'
    FROM huis.firms f
   WHERE f.id = p_firm_id AND f.status = 'active' AND f.first_paid_at IS NULL
     AND f.plan = 'trial' AND f.trial_ends_at <= now()
$$;

-- AI questions counted for the firm's limit: on the trial, since the firm signed up (the whole trial);
-- on a paid plan, this calendar month (UTC). Only questions people ask count (brain_answers, ai_agent_turns).
CREATE OR REPLACE FUNCTION huis.firm_ai_questions_this_month(p_firm_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  WITH since AS (
    SELECT CASE WHEN f.plan = 'trial' THEN f.created_at
                ELSE date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS t
      FROM huis.firms f WHERE f.id = p_firm_id
  )
  SELECT ((SELECT count(*) FROM huis.brain_answers b, since WHERE b.firm_id = p_firm_id AND b.created_at >= since.t)
        + (SELECT count(*) FROM huis.ai_agent_turns a, since WHERE a.firm_id = p_firm_id AND a.created_at >= since.t))::int
$$;

CREATE FUNCTION huis.ai_limit_message(p_limit int) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('The free trial includes %s AI questions (questions you ask Matter Brain or an AI agent), and the firm has used them all. '
             || 'Everything Huis does automatically still works. Subscribe to keep asking.', p_limit)
$$;

CREATE OR REPLACE FUNCTION huis.ai_question_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit int;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_block := huis.write_block_for_caller(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).ai_questions_per_month;
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  IF huis.firm_ai_questions_this_month(NEW.firm_id) + 1 > v_limit THEN
    RAISE EXCEPTION '%', huis.ai_limit_message(v_limit) USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION huis.my_ai_question_check() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); v_block text; v_limit int;
BEGIN
  IF v_firm IS NULL THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  v_block := huis.write_block_for_caller(v_firm);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(v_firm)).ai_questions_per_month;
  IF v_limit IS NOT NULL AND huis.firm_ai_questions_this_month(v_firm) + 1 > v_limit THEN
    RAISE EXCEPTION '%', huis.ai_limit_message(v_limit) USING ERRCODE = 'HU402';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Case description: when an attorney starts a Matter with a description of the case, Huis reads it and
-- suggests people, organizations, key dates and possible claims for the attorney to confirm or reject in
-- Case DNA. Automatic: it never counts as an AI question.
--
-- The app passes what it found (kind, label, the passage's position); this function checks the caller may
-- change the Matter and wrote the note, and quotes each passage from the stored note itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.suggest_from_case_description(p_note_id uuid, p_items jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  x huis.matter_notes;
  v_text text;
  e jsonb;
  v_kind text; v_start int; v_end int; v_quote text; v_node uuid; v_date date;
  n int := 0;
BEGIN
  SELECT * INTO x FROM huis.matter_notes WHERE id = p_note_id;
  IF NOT FOUND OR x.firm_id IS DISTINCT FROM huis.current_firm_id() OR x.author_id IS DISTINCT FROM huis.current_user_id()
     OR NOT coalesce(huis.is_internal_role(huis.app_role()), false) OR NOT huis.dna_writable(x.matter_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 60 THEN RAISE EXCEPTION 'invalid suggestions'; END IF;
  IF (SELECT count(*) FROM huis.dna_nodes WHERE matter_id = x.matter_id AND origin = 'huis' AND status = 'suggested') >= 2000 THEN
    RETURN 0;
  END IF;
  v_text := x.title || E'\n\n' || x.body;

  FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_kind := e->>'kind';
      CONTINUE WHEN v_kind NOT IN ('event', 'person', 'organization', 'claim');
      v_start := (e->>'start')::int; v_end := (e->>'end')::int;
      CONTINUE WHEN v_start IS NULL OR v_end IS NULL OR v_start < 0 OR v_end <= v_start OR v_end > length(v_text);
      v_quote := left(btrim(regexp_replace(substr(v_text, v_start + 1, v_end - v_start), '\s+', ' ', 'g')), 1500);
      CONTINUE WHEN v_quote = '' OR length(btrim(coalesce(e->>'label', ''))) = 0;
      v_date := CASE WHEN v_kind = 'event' THEN (e->>'date')::date END;
      CONTINUE WHEN v_kind = 'event' AND v_date IS NULL;
      v_node := NULL;
      INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, origin_key)
        VALUES (x.firm_id, x.matter_id, v_kind, left(btrim(e->>'label'), 300), v_date, 'suggested', 'huis',
                format('description:%s:%s:%s', x.id, v_kind, v_start))
        ON CONFLICT (matter_id, origin_key) DO NOTHING
        RETURNING id INTO v_node;
      IF v_node IS NOT NULL THEN
        INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, note_id, char_start, char_end, quote)
          VALUES (x.firm_id, x.matter_id, v_node, x.id, v_start, v_end, v_quote);
        n := n + 1;
      END IF;
    EXCEPTION WHEN others THEN
      -- One odd suggestion never stops the rest.
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.suggest_from_case_description(uuid, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.suggest_from_case_description(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.suggest_from_case_description(uuid, jsonb) TO huis_app;
GRANT SELECT ON huis.matter_notes TO huis_security;
GRANT SELECT, INSERT ON huis.dna_nodes, huis.dna_citations TO huis_security;
GRANT USAGE ON SEQUENCE huis.dna_citations_id_seq TO huis_security;
