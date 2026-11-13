-- Phase 10 part 2b: deleting an unpaid trial's data.
--
-- Decided by Tracy (11 November 2026): only a firm that never paid is deleted, 30 days after its trial ended
-- (huis.firm_delete_after). A firm that ever paid is held, read and export only, never deleted for non-payment.
--
-- Safeguards, all in the database:
--   * Warnings first. The firm's owners are emailed 14, 7 and 1 days before the date. Deletion needs all three
--     warnings to have been SENT (not just queued) for that same date, the 14-day one at least 13 days earlier
--     and the 1-day one at least 23 hours earlier. If warnings start late (a trial extended, a firm restored) the
--     deletion waits; it never happens early. No email service set up = no warnings sent = no deletion.
--   * Re-checked at the moment of deletion, under a lock on the firm, so paying, an extended trial or a Huis
--     suspension a second earlier stops it.
--   * The worker also needs HUIS_TRIAL_DELETION=on (src/billing/trialDeletion.ts). Off by default: Tracy turns it
--     on once the terms of service and privacy policy say so.
--   * What remains: a tombstone (firm id, dates, row count) with no name, people or client information.
--
-- Also: mailbox sync stops for firms without access (paused) and for people the firm's sign-in rule leaves out
-- (security review 31's open item).

CREATE TABLE huis.firm_deletion_notices (
  id               bigserial PRIMARY KEY,
  firm_id          uuid NOT NULL REFERENCES huis.firms(id),
  user_id          uuid NOT NULL,
  days_before      int NOT NULL CHECK (days_before IN (14, 7, 1)),
  for_delete_after timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'waiting_for_provider')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text CHECK (length(last_error) <= 200),
  queued_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  UNIQUE (firm_id, user_id, days_before, for_delete_after)
);
CREATE INDEX firm_deletion_notices_queue ON huis.firm_deletion_notices (status, updated_at);
ALTER TABLE huis.firm_deletion_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.firm_deletion_notices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.firm_deletion_notices FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.firm_deletion_notices TO huis_security;
GRANT USAGE ON SEQUENCE huis.firm_deletion_notices_id_seq TO huis_security;

-- What is left of a deleted firm: no name, no people, no client information.
CREATE TABLE huis.firm_deletions (
  firm_id          uuid PRIMARY KEY,
  trial_ended_at   timestamptz NOT NULL,
  delete_after     timestamptz NOT NULL,
  warned           jsonb NOT NULL,           -- {"14": first sent, "7": ..., "1": ...}
  rows_deleted     bigint NOT NULL,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  files_deleted_at timestamptz
);
REVOKE ALL ON huis.firm_deletions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON huis.firm_deletions TO huis_security;

-- True only inside huis.worker_delete_firm for that firm, in that transaction. A row only huis_security can write,
-- tied to the transaction id, so nothing else (not a setting the app could set, not another definer function
-- running as huis_security) can turn it on.
CREATE TABLE huis.firm_deletion_in_progress (
  firm_id uuid PRIMARY KEY,
  txid    bigint NOT NULL
);
REVOKE ALL ON huis.firm_deletion_in_progress FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON huis.firm_deletion_in_progress TO huis_security;

CREATE FUNCTION huis.firm_being_deleted(p_firm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM huis.firm_deletion_in_progress d WHERE d.firm_id = p_firm_id AND d.txid = txid_current())
$$;
ALTER FUNCTION huis.firm_being_deleted(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_being_deleted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.firm_being_deleted(uuid) TO PUBLIC;

-- For statement-level guards (no row to read the firm from): a firm deletion is running in this transaction.
-- Only huis.worker_delete_firm sets that up, and it deletes only that firm's rows.
CREATE FUNCTION huis.any_firm_being_deleted() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM huis.firm_deletion_in_progress d WHERE d.txid = txid_current())
$$;
ALTER FUNCTION huis.any_firm_being_deleted() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.any_firm_being_deleted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.any_firm_being_deleted() TO PUBLIC;

-- The append-only and invoice guards let that one deletion through (including the links to deleted people being
-- cleared on the way), and nothing else.
DO $$
DECLARE fn text; def text; patched text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['audit_events_immutable', 'expense_guard', 'time_entry_guard', 'invoice_delete_guard'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'huis' AND p.proname = fn AND p.pronargs = 0;
    IF def IS NULL THEN RAISE EXCEPTION 'guard % not found', fn; END IF;
    patched := regexp_replace(def, E'\\nBEGIN\\n',
      E'\nBEGIN\n  IF TG_LEVEL = ''STATEMENT'' AND TG_OP = ''DELETE'' THEN\n    IF huis.any_firm_being_deleted() THEN RETURN NULL; END IF;\n  END IF;\n  IF TG_LEVEL = ''ROW'' AND TG_OP IN (''DELETE'', ''UPDATE'') THEN\n    IF huis.firm_being_deleted(OLD.firm_id) THEN\n      IF TG_OP = ''DELETE'' THEN RETURN OLD; END IF;\n      RETURN NEW;\n    END IF;\n  END IF;\n');
    IF patched = def THEN RAISE EXCEPTION 'could not patch guard %', fn; END IF;
    EXECUTE patched;
  END LOOP;
END $$;

GRANT DELETE ON ALL TABLES IN SCHEMA huis TO huis_security;
GRANT SELECT ON ALL TABLES IN SCHEMA huis TO huis_security;

-- Is this firm due for deletion right now? (Date reached and every warning sent in time.)
CREATE FUNCTION huis.firm_deletion_due(p_firm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  WITH d AS (SELECT huis.firm_delete_after(p_firm_id) AS at),
  w AS (
    SELECT n.days_before, min(n.sent_at) AS sent
      FROM huis.firm_deletion_notices n, d
     WHERE n.firm_id = p_firm_id AND n.status = 'sent' AND n.for_delete_after = d.at
     GROUP BY n.days_before)
  SELECT d.at IS NOT NULL AND now() >= d.at
     AND EXISTS (SELECT 1 FROM w WHERE days_before = 14 AND sent <= now() - interval '13 days')
     AND EXISTS (SELECT 1 FROM w WHERE days_before = 7  AND sent <= now() - interval '6 days')
     AND EXISTS (SELECT 1 FROM w WHERE days_before = 1  AND sent <= now() - interval '23 hours')
    FROM d
$$;
ALTER FUNCTION huis.firm_deletion_due(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_deletion_due(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.firm_deletion_due(uuid) TO huis_security;

-- Queues the warnings that are due (one per active owner). Returns how many were added.
CREATE FUNCTION huis.worker_queue_deletion_notices() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v int := 0; n int;
BEGIN
  INSERT INTO huis.firm_deletion_notices (firm_id, user_id, days_before, for_delete_after)
  SELECT f.id, u.id, k.days, huis.firm_delete_after(f.id)
    FROM huis.firms f
    CROSS JOIN (VALUES (14), (7), (1)) AS k(days)
    JOIN huis.users u ON u.firm_id = f.id AND u.role = 'firm_owner' AND u.status = 'active'
   WHERE f.plan = 'trial' AND f.first_paid_at IS NULL AND f.status = 'active'
     AND huis.firm_delete_after(f.id) IS NOT NULL
     AND now() >= huis.firm_delete_after(f.id) - make_interval(days => k.days)
  ON CONFLICT (firm_id, user_id, days_before, for_delete_after) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; v := v + n;
  -- Failed sends are tried again after an hour, up to 5 times.
  UPDATE huis.firm_deletion_notices SET status = 'queued', updated_at = now()
   WHERE status = 'failed' AND attempts < 5 AND updated_at < now() - interval '1 hour';
  -- Claimed but never finished (worker stopped): back in the queue after 15 minutes.
  UPDATE huis.firm_deletion_notices SET status = 'queued', updated_at = now()
   WHERE status = 'sending' AND updated_at < now() - interval '15 minutes';
  RETURN v;
END $$;

-- Once an email service exists, warnings that waited for one are queued again.
CREATE FUNCTION huis.worker_retry_waiting_deletion_notices() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  UPDATE huis.firm_deletion_notices SET status = 'queued', updated_at = now() WHERE status = 'waiting_for_provider'
$$;

-- One warning to send, checked again now: the firm must still be due on that same date.
CREATE FUNCTION huis.worker_claim_deletion_notice()
RETURNS TABLE (notice_id bigint, email text, firm_name text, delete_after timestamptz, time_zone text, days_before int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n huis.firm_deletion_notices;
BEGIN
  LOOP
    SELECT * INTO n FROM huis.firm_deletion_notices x WHERE x.status = 'queued'
     ORDER BY x.queued_at FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    IF huis.firm_delete_after(n.firm_id) IS DISTINCT FROM n.for_delete_after
       OR NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.id = n.user_id AND u.firm_id = n.firm_id AND u.status = 'active' AND u.role = 'firm_owner') THEN
      -- The firm paid, the trial was extended, or the person left: this warning no longer applies.
      DELETE FROM huis.firm_deletion_notices WHERE id = n.id;
      CONTINUE;
    END IF;
    UPDATE huis.firm_deletion_notices SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = n.id;
    RETURN QUERY SELECT n.id, u.email, f.name, n.for_delete_after, f.time_zone, n.days_before
      FROM huis.users u JOIN huis.firms f ON f.id = u.firm_id WHERE u.id = n.user_id;
    RETURN;
  END LOOP;
END $$;

CREATE FUNCTION huis.worker_finish_deletion_notice(p_notice_id bigint, p_status text, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'waiting_for_provider') THEN RAISE EXCEPTION 'invalid status'; END IF;
  UPDATE huis.firm_deletion_notices
     SET status = p_status, updated_at = now(), last_error = left(p_error, 200),
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END
   WHERE id = p_notice_id AND status = 'sending';
END $$;

-- The next firm due for deletion, if any.
CREATE FUNCTION huis.worker_next_firm_to_delete() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.id FROM huis.firms f
   WHERE f.plan = 'trial' AND f.first_paid_at IS NULL AND f.status = 'active' AND f.trial_ends_at <= now() - interval '30 days'
     AND huis.firm_deletion_due(f.id)
   ORDER BY f.trial_ends_at LIMIT 1
$$;

-- Deletes every row of the firm in one transaction, after checking again under a lock that it is due. Returns
-- the storage prefix of its files (for the worker to delete), or NULL if it isn't due.
CREATE FUNCTION huis.worker_delete_firm(p_firm_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f huis.firms; v_after timestamptz; v_warned jsonb; v_google text[];
  v_tables text[]; t text; v_n bigint; v_rows bigint := 0; v_failed int; v_progress boolean; v_passes int := 0;
BEGIN
  SELECT * INTO f FROM huis.firms x WHERE x.id = p_firm_id FOR UPDATE;
  IF NOT FOUND OR NOT huis.firm_deletion_due(p_firm_id) THEN RETURN NULL; END IF;
  v_after := huis.firm_delete_after(p_firm_id);
  SELECT jsonb_object_agg(days_before::text, sent) INTO v_warned FROM (
    SELECT days_before, min(sent_at) AS sent FROM huis.firm_deletion_notices
     WHERE firm_id = p_firm_id AND status = 'sent' AND for_delete_after = v_after GROUP BY days_before) w;
  SELECT array_agg(DISTINCT u.auth_subject) INTO v_google FROM huis.users u
   WHERE u.firm_id = p_firm_id AND u.auth_provider = 'google' AND u.auth_subject IS NOT NULL;

  INSERT INTO huis.firm_deletion_in_progress (firm_id, txid) VALUES (p_firm_id, txid_current());

  -- Tables that hang off firm rows without a firm_id of their own.
  DELETE FROM huis.evidence_lsh WHERE evidence_id IN (SELECT evidence_id FROM huis.evidence_fingerprints WHERE firm_id = p_firm_id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM huis.unpack_counters WHERE item_id IN (SELECT id FROM huis.evidence_items WHERE firm_id = p_firm_id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM huis.bates_counters WHERE matter_id IN (SELECT id FROM huis.matters WHERE firm_id = p_firm_id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  -- (mail_credentials, integration_credentials and integration_listing_items go with their connections.)

  -- Every other table with the firm's id, children before parents: retried until nothing is left.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'huis' AND c.relkind IN ('r', 'p')
     AND c.relname NOT IN ('firms', 'firm_deletions', 'platform_audit', 'firm_deletion_in_progress')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'firm_id' AND NOT a.attisdropped);
  LOOP
    v_passes := v_passes + 1; v_failed := 0; v_progress := false;
    FOREACH t IN ARRAY v_tables LOOP
      BEGIN
        EXECUTE format('DELETE FROM huis.%I WHERE firm_id = $1', t) USING p_firm_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_rows := v_rows + v_n; v_progress := true; END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        v_failed := v_failed + 1;
      END;
    END LOOP;
    EXIT WHEN v_failed = 0;
    IF NOT v_progress OR v_passes > 50 THEN RAISE EXCEPTION 'firm deletion could not finish (tables still referenced)'; END IF;
  END LOOP;

  -- Google identities recorded only for this firm's people.
  DELETE FROM huis.identity_orgs o WHERE o.provider = 'google' AND o.subject = ANY (coalesce(v_google, '{}'))
     AND NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.auth_provider = 'google' AND u.auth_subject = o.subject);

  DELETE FROM huis.firms WHERE id = p_firm_id;
  v_rows := v_rows + 1;
  DELETE FROM huis.firm_deletion_in_progress WHERE firm_id = p_firm_id;
  INSERT INTO huis.firm_deletions (firm_id, trial_ended_at, delete_after, warned, rows_deleted)
    VALUES (p_firm_id, f.trial_ends_at, v_after, coalesce(v_warned, '{}'), v_rows);
  RETURN 'firm/' || p_firm_id::text || '/';
END $$;

-- Files of deleted firms still to remove (the rows are gone; the files are deleted after, and retried).
CREATE FUNCTION huis.worker_firm_files_pending() RETURNS TABLE (firm_id uuid, prefix text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT d.firm_id, 'firm/' || d.firm_id::text || '/' FROM huis.firm_deletions d WHERE d.files_deleted_at IS NULL ORDER BY d.deleted_at LIMIT 1
$$;
CREATE FUNCTION huis.worker_firm_files_deleted(p_firm_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  UPDATE huis.firm_deletions SET files_deleted_at = now() WHERE firm_id = p_firm_id AND files_deleted_at IS NULL
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['worker_queue_deletion_notices()', 'worker_retry_waiting_deletion_notices()', 'worker_claim_deletion_notice()',
                            'worker_finish_deletion_notice(bigint, text, text)', 'worker_next_firm_to_delete()', 'worker_delete_firm(uuid)',
                            'worker_firm_files_pending()', 'worker_firm_files_deleted(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION huis.%s OWNER TO huis_security', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION huis.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION huis.%s TO huis_worker', fn);
  END LOOP;
END $$;

-- Mailbox sync: not for firms without access (paused or ended), nor for people the firm's sign-in rule leaves out.
CREATE OR REPLACE FUNCTION huis.worker_claim_mailbox()
RETURNS TABLE (connection_id uuid, lock_token uuid, firm_id uuid, provider text, account_subject text, scope text, sync_since date, ciphertext bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c huis.mail_connections;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT mc.* INTO c FROM huis.mail_connections mc JOIN huis.users o ON o.id = mc.owner_user_id
   WHERE mc.status = 'active' AND mc.next_sync_at <= now() AND (mc.locked_until IS NULL OR mc.locked_until < now())
     AND o.status = 'active' AND huis.is_internal_role(o.role)
     AND huis.firm_write_block(mc.firm_id) IS NULL
     AND huis.signin_allowed(o.firm_id, o.role, o.auth_provider, o.auth_subject)
   ORDER BY mc.next_sync_at FOR UPDATE OF mc SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.mail_connections SET lock_token = v_token, locked_until = now() + interval '30 minutes' WHERE id = c.id;
  RETURN QUERY SELECT c.id, v_token, c.firm_id, c.provider, c.account_subject, c.scope, c.sync_since,
    (SELECT k.ciphertext FROM huis.mail_credentials k WHERE k.connection_id = c.id);
END $$;
GRANT EXECUTE ON FUNCTION huis.firm_write_block(uuid) TO huis_security;
