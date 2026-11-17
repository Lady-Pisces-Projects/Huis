-- Security review 32 (Phase 10 part 2b, deleting an unpaid trial's data).
--
-- R32-1: a trial firm whose Stripe subscription could still charge (trialing, past_due, unpaid, paused) was
--        deleted. Such a firm is now held: no warnings, no date, no deletion, until Stripe reports the
--        subscription finished (canceled or incomplete_expired).
-- R32-2: warnings sent before Huis suspended a firm still counted after it was restored, so it was deleted at once.
-- R32-3: warnings that started late went out together, naming a date already past.
--        Both fixed with a deletion round: when a firm first becomes due for warnings, Huis fixes the actual
--        deletion date as the later of the usual date and 14 days from then; warnings name that date and go
--        out 14, 7 and 1 days before it. Anything that makes the firm ineligible (paying, a Stripe subscription,
--        a suspension, a changed trial end) ends the round and its warnings; becoming eligible again starts a new
--        round with a full 14 days.
-- R32-4: one firm whose files or rows couldn't be deleted blocked every other firm. Failures are now recorded and
--        retried later (hourly, backing off), and the worker moves on.
-- R32-5: the blanket DELETE grant let huis_security erase the staff log and the tombstones. Revoked.
-- Also: the usual date is 720 hours after the trial ended (not "30 days", which moves an hour across a daylight
--       saving change depending on the session's time zone).

REVOKE DELETE ON huis.platform_audit, huis.firm_deletions FROM huis_security;

-- The usual date, before any round: 720 hours after the trial ended, for a firm that never paid.
CREATE FUNCTION huis.firm_trial_delete_base(p_firm_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.trial_ends_at + interval '720 hours'
    FROM huis.firms f
   WHERE f.id = p_firm_id AND f.status = 'active' AND f.first_paid_at IS NULL
     AND f.plan = 'trial' AND f.trial_ends_at <= now()
     AND NOT huis.platform_stripe_live(f)
$$;
ALTER FUNCTION huis.firm_trial_delete_base(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_trial_delete_base(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.firm_trial_delete_base(uuid) TO huis_security;

CREATE TABLE huis.firm_deletion_rounds (
  firm_id     uuid PRIMARY KEY REFERENCES huis.firms(id),
  base_after  timestamptz NOT NULL,   -- the usual date this round was set for
  delete_on   timestamptz NOT NULL,   -- the actual date: never sooner than 14 days after the round started
  started_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE huis.firm_deletion_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.firm_deletion_rounds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.firm_deletion_rounds FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.firm_deletion_rounds TO huis_security;

CREATE TABLE huis.firm_deletion_failures (
  firm_id     uuid PRIMARY KEY,   -- no foreign key: kept for tombstoned firms whose files failed too
  stage       text NOT NULL CHECK (stage IN ('rows', 'files')),
  attempts    int NOT NULL DEFAULT 1,
  next_try    timestamptz NOT NULL,
  last_error  text CHECK (length(last_error) <= 200)
);
REVOKE ALL ON huis.firm_deletion_failures FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.firm_deletion_failures TO huis_security;

-- The date shown to the firm and staff, and the one deletion follows: the round's date while a round for the
-- current usual date is running, otherwise the usual date. NULL while the firm isn't headed for deletion
-- (paid, suspended, Stripe subscription live, trial running).
CREATE OR REPLACE FUNCTION huis.firm_delete_after(p_firm_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE WHEN r.firm_id IS NOT NULL AND r.base_after = b.base THEN r.delete_on ELSE b.base END
    FROM (SELECT huis.firm_trial_delete_base(p_firm_id) AS base) b
    LEFT JOIN huis.firm_deletion_rounds r ON r.firm_id = p_firm_id
   WHERE b.base IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION huis.worker_queue_deletion_notices() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v int := 0;
BEGIN
  -- A round ends when the firm stops being headed for deletion or its usual date changes; its unsent warnings go.
  DELETE FROM huis.firm_deletion_rounds r
   WHERE huis.firm_trial_delete_base(r.firm_id) IS DISTINCT FROM r.base_after;
  DELETE FROM huis.firm_deletion_notices n
   WHERE NOT EXISTS (SELECT 1 FROM huis.firm_deletion_rounds r WHERE r.firm_id = n.firm_id AND r.delete_on = n.for_delete_after);

  -- A round starts 14 days before the usual date (or at once if that is already closer or past).
  INSERT INTO huis.firm_deletion_rounds (firm_id, base_after, delete_on)
  SELECT f.id, b.base, greatest(b.base, now() + interval '14 days')
    FROM huis.firms f CROSS JOIN LATERAL (SELECT huis.firm_trial_delete_base(f.id) AS base) b
   WHERE f.plan = 'trial' AND f.first_paid_at IS NULL AND f.status = 'active'
     AND b.base IS NOT NULL AND now() >= b.base - interval '14 days'
  ON CONFLICT (firm_id) DO NOTHING;

  INSERT INTO huis.firm_deletion_notices (firm_id, user_id, days_before, for_delete_after)
  SELECT r.firm_id, u.id, k.days, r.delete_on
    FROM huis.firm_deletion_rounds r
    CROSS JOIN (VALUES (14), (7), (1)) AS k(days)
    JOIN huis.users u ON u.firm_id = r.firm_id AND u.role = 'firm_owner' AND u.status = 'active'
   WHERE now() >= r.delete_on - make_interval(days => k.days)
     -- Only the latest warning that is due: if the worker was down, owners don't get a burst.
     AND NOT EXISTS (SELECT 1 FROM (VALUES (14), (7), (1)) AS later(days)
                      WHERE later.days < k.days AND now() >= r.delete_on - make_interval(days => later.days))
  ON CONFLICT (firm_id, user_id, days_before, for_delete_after) DO NOTHING;
  GET DIAGNOSTICS v = ROW_COUNT;

  UPDATE huis.firm_deletion_notices SET status = 'queued', updated_at = now()
   WHERE status = 'failed' AND attempts < 5 AND updated_at < now() - interval '1 hour';
  UPDATE huis.firm_deletion_notices SET status = 'queued', updated_at = now()
   WHERE status = 'sending' AND updated_at < now() - interval '15 minutes';
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION huis.worker_claim_deletion_notice()
RETURNS TABLE (notice_id bigint, email text, firm_name text, delete_after timestamptz, time_zone text, days_before int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n huis.firm_deletion_notices;
BEGIN
  LOOP
    SELECT * INTO n FROM huis.firm_deletion_notices x WHERE x.status = 'queued'
     ORDER BY x.queued_at FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    IF huis.firm_delete_after(n.firm_id) IS DISTINCT FROM n.for_delete_after
       OR NOT EXISTS (SELECT 1 FROM huis.firm_deletion_rounds r WHERE r.firm_id = n.firm_id AND r.delete_on = n.for_delete_after)
       OR NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.id = n.user_id AND u.firm_id = n.firm_id AND u.status = 'active' AND u.role = 'firm_owner') THEN
      DELETE FROM huis.firm_deletion_notices WHERE id = n.id;
      CONTINUE;
    END IF;
    UPDATE huis.firm_deletion_notices SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = n.id;
    RETURN QUERY SELECT n.id, u.email, f.name, n.for_delete_after, f.time_zone, n.days_before
      FROM huis.users u JOIN huis.firms f ON f.id = u.firm_id WHERE u.id = n.user_id;
    RETURN;
  END LOOP;
END $$;

-- Due: a running round for the current usual date, its date reached, and its warnings sent in time. Because only
-- the latest due warning is ever queued, the 1-day warning must have been sent at least 23 hours earlier, and
-- the round itself is at least 14 days old by construction.
CREATE OR REPLACE FUNCTION huis.firm_deletion_due(p_firm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce((
    SELECT now() >= r.delete_on
       AND r.base_after = huis.firm_trial_delete_base(p_firm_id)
       AND r.started_at <= now() - interval '13 days'
       AND EXISTS (SELECT 1 FROM huis.firm_deletion_notices n WHERE n.firm_id = p_firm_id AND n.for_delete_after = r.delete_on
                     AND n.days_before = 14 AND n.status = 'sent' AND n.sent_at <= now() - interval '13 days')
       AND EXISTS (SELECT 1 FROM huis.firm_deletion_notices n WHERE n.firm_id = p_firm_id AND n.for_delete_after = r.delete_on
                     AND n.days_before = 1 AND n.status = 'sent' AND n.sent_at <= now() - interval '23 hours')
      FROM huis.firm_deletion_rounds r WHERE r.firm_id = p_firm_id), false)
$$;

CREATE OR REPLACE FUNCTION huis.worker_next_firm_to_delete() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT r.firm_id FROM huis.firm_deletion_rounds r
   WHERE r.delete_on <= now() AND huis.firm_deletion_due(r.firm_id)
     AND NOT EXISTS (SELECT 1 FROM huis.firm_deletion_failures x WHERE x.firm_id = r.firm_id AND x.next_try > now())
   ORDER BY r.delete_on LIMIT 1
$$;

CREATE OR REPLACE FUNCTION huis.worker_firm_files_pending() RETURNS TABLE (firm_id uuid, prefix text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT d.firm_id, 'firm/' || d.firm_id::text || '/' FROM huis.firm_deletions d
   WHERE d.files_deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM huis.firm_deletion_failures x WHERE x.firm_id = d.firm_id AND x.next_try > now())
   ORDER BY d.deleted_at LIMIT 1
$$;

CREATE OR REPLACE FUNCTION huis.worker_firm_files_deleted(p_firm_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  UPDATE huis.firm_deletions SET files_deleted_at = now() WHERE firm_id = p_firm_id AND files_deleted_at IS NULL;
  DELETE FROM huis.firm_deletion_failures WHERE firm_id = p_firm_id;
$$;

-- A failed deletion (rows or files) is tried again later, backing off from 1 hour up to a day.
CREATE FUNCTION huis.worker_firm_deletion_failed(p_firm_id uuid, p_stage text, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF p_stage NOT IN ('rows', 'files') THEN RAISE EXCEPTION 'invalid stage'; END IF;
  INSERT INTO huis.firm_deletion_failures (firm_id, stage, next_try, last_error)
    VALUES (p_firm_id, p_stage, now() + interval '1 hour', left(p_error, 200))
  ON CONFLICT (firm_id) DO UPDATE
    SET stage = EXCLUDED.stage, attempts = huis.firm_deletion_failures.attempts + 1, last_error = EXCLUDED.last_error,
        next_try = now() + least(interval '24 hours', interval '1 hour' * power(2, huis.firm_deletion_failures.attempts));
END $$;
ALTER FUNCTION huis.worker_firm_deletion_failed(uuid, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_firm_deletion_failed(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_firm_deletion_failed(uuid, text, text) TO huis_worker;

-- worker_delete_firm also clears a firm's failure record when it succeeds, and its round goes with the firm.
CREATE OR REPLACE FUNCTION huis.worker_delete_firm_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM huis.firm_deletion_failures WHERE firm_id = NEW.firm_id AND stage = 'rows';
  RETURN NEW;
END $$;
CREATE TRIGGER firm_deletions_cleanup AFTER INSERT ON huis.firm_deletions FOR EACH ROW EXECUTE FUNCTION huis.worker_delete_firm_cleanup();
