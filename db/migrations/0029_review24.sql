-- Security review 24 (Phase 10 part 1: subscriptions, the trial, seats and usage).
--
-- R24-1: the trial's storage limit counted only what was uploaded, so an archive under the limit could unpack
--        to many times it. Unpacked files now count against the limit too (unpacking keeps what fits and
--        reports the rest, as for its other safety limits).
-- R24-2: clients and other outside users were told the firm's billing standing ("payment is overdue"). They
--        now get a neutral message, and the firm-wide notice is for firm staff only.
-- R24-3: a suspended firm couldn't sign in at all, though Huis promises it can still open and export its
--        work. Suspended firms sign in (new work stays paused); "disabled" is still a full lock-out.
-- R24-4: a working copy asked for before the trial ended failed (five times) once it had, because the copy is
--        a new item. Copies of evidence already held aren't new work: they finish (storage still counts).
-- R24-5: my_firm_subscription() let a caller with no role through (NULL NOT IN … is not true).
-- R24-7: the AI-question limit was checked only after the AI work was done. my_ai_question_check() lets the
--        app check first; the triggers stay as the guarantee.

-- What the caller may be told about why new work is paused (null when it isn't).
CREATE FUNCTION huis.write_block_for_caller(p_firm_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN b.msg IS NULL THEN NULL
    -- Firm staff, and the worker (no user), get the reason; outside users don't learn the firm's standing.
    WHEN huis.current_user_id() IS NULL OR coalesce(huis.is_internal_role(huis.app_role()), false) THEN b.msg
    ELSE 'Adding new documents is paused for now. Please contact your law firm.'
  END
  FROM (SELECT huis.firm_write_block(p_firm_id) AS msg) b
$$;
ALTER FUNCTION huis.write_block_for_caller(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.write_block_for_caller(uuid) FROM PUBLIC;

-- R24-2: the notice is for firm staff.
CREATE OR REPLACE FUNCTION huis.my_firm_write_block() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE WHEN huis.current_firm_id() IS NULL OR NOT coalesce(huis.is_internal_role(huis.app_role()), false) THEN NULL
              ELSE huis.firm_write_block(huis.current_firm_id()) END
$$;

-- R24-2, R24-4: neutral message for outside users; copies of held evidence finish.
CREATE OR REPLACE FUNCTION huis.require_active_subscription() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  -- What's derived from work already received (a container's files, a working copy) is finished.
  -- (Nested: these columns exist only on evidence_items.)
  IF TG_TABLE_NAME = 'evidence_items' THEN
    IF NEW.parent_id IS NOT NULL OR NEW.source = 'produced_copy' THEN RETURN NEW; END IF;
  END IF;
  v_block := huis.write_block_for_caller(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  RETURN NEW;
END $$;

-- R24-1: every stored file counts, unpacked ones included.
CREATE OR REPLACE FUNCTION huis.evidence_storage_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_limit bigint;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).storage_limit_bytes;
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  PERFORM huis.lock_firm_usage(NEW.firm_id);
  IF huis.firm_storage_used(NEW.firm_id) + coalesce(NEW.size_bytes, 0) > v_limit THEN
    RAISE EXCEPTION '%', CASE WHEN huis.current_user_id() IS NULL OR coalesce(huis.is_internal_role(huis.app_role()), false)
      THEN format('This would go past the trial''s storage limit (%s GB). Subscribe to add more evidence.', round(v_limit / 1073741824.0, 1))
      ELSE 'Adding new documents is paused for now. Please contact your law firm.' END
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION huis.upload_start_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_block text; v_limit bigint;
BEGIN
  IF NOT huis.usage_check_applies(NEW.firm_id) THEN RETURN NEW; END IF;
  v_block := huis.write_block_for_caller(NEW.firm_id);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(NEW.firm_id)).storage_limit_bytes;
  IF v_limit IS NOT NULL AND huis.firm_storage_used(NEW.firm_id) + coalesce(NEW.total_size, 0) > v_limit THEN
    RAISE EXCEPTION '%', CASE WHEN coalesce(huis.is_internal_role(huis.app_role()), false)
      THEN format('This would go past the trial''s storage limit (%s GB). Subscribe to add more evidence.', round(v_limit / 1073741824.0, 1))
      ELSE 'Adding new documents is paused for now. Please contact your law firm.' END
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;

-- R24-3: suspended firms can still sign in to read and export.
CREATE OR REPLACE FUNCTION huis.resolve_identity(p_provider text, p_subject text)
RETURNS TABLE (firm_id uuid, user_id uuid, firm_name text, role huis.firm_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT u.firm_id, u.id, f.name, u.role
  FROM huis.users u JOIN huis.firms f ON f.id = u.firm_id
  WHERE u.auth_provider = p_provider AND u.auth_subject = p_subject
    AND u.status = 'active' AND f.status IN ('active', 'suspended')
  ORDER BY f.name
$$;

-- R24-5: fail closed with no role.
CREATE OR REPLACE FUNCTION huis.my_firm_subscription(
  OUT plan text, OUT plan_name text, OUT price_cents_per_seat int, OUT trial_ends_at timestamptz, OUT paid_through timestamptz,
  OUT seat_limit int, OUT seats_used int, OUT external_users int,
  OUT storage_limit_bytes bigint, OUT storage_used_bytes bigint,
  OUT ai_questions_per_month int, OUT ai_questions_used int, OUT write_block text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); l record;
BEGIN
  IF v_firm IS NULL OR coalesce(huis.app_role()::text, '') NOT IN ('firm_owner', 'managing_partner', 'firm_admin', 'billing_admin') THEN
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

-- R24-7: the same check the AI triggers make, for the caller's firm, before any AI work starts.
CREATE FUNCTION huis.my_ai_question_check() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); v_block text; v_limit int;
BEGIN
  IF v_firm IS NULL THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  v_block := huis.write_block_for_caller(v_firm);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block USING ERRCODE = 'HU402'; END IF;
  v_limit := (huis.firm_limits(v_firm)).ai_questions_per_month;
  IF v_limit IS NOT NULL AND huis.firm_ai_questions_this_month(v_firm) + 1 > v_limit THEN
    RAISE EXCEPTION 'The firm has used this month''s % AI questions on the trial. Subscribe to keep asking.', v_limit
      USING ERRCODE = 'HU402';
  END IF;
END $$;
ALTER FUNCTION huis.my_ai_question_check() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_ai_question_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_ai_question_check() TO huis_app;

-- AI questions use the caller-aware message too.
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
    RAISE EXCEPTION 'The firm has used this month''s % AI questions on the trial. Subscribe to keep asking.', v_limit
      USING ERRCODE = 'HU402';
  END IF;
  RETURN NEW;
END $$;
