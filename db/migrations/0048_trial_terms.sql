-- The free trial's non-payment and data-deletion terms (src/billing/trialTerms.ts): which version the firm's owner
-- accepted, and when, recorded when the firm is created and in its audit log. The app can't change it afterwards.

ALTER TABLE huis.firms
  ADD COLUMN trial_terms_version text CHECK (trial_terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ADD COLUMN trial_terms_accepted_at timestamptz;

GRANT SELECT (trial_terms_version, trial_terms_accepted_at) ON huis.firms TO huis_app;

-- Called in the same transaction as huis.bootstrap_firm: only for a firm created in the last few minutes, for its
-- owner, once.
CREATE FUNCTION huis.record_trial_terms(p_firm uuid, p_user uuid, p_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF p_version IS NULL OR p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid trial terms version';
  END IF;
  UPDATE huis.firms f SET trial_terms_version = p_version, trial_terms_accepted_at = now()
   WHERE f.id = p_firm AND f.trial_terms_accepted_at IS NULL AND f.created_at > now() - interval '5 minutes'
     AND EXISTS (SELECT 1 FROM huis.users u WHERE u.id = p_user AND u.firm_id = p_firm AND u.role = 'firm_owner');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trial terms can only be recorded when the firm is created';
  END IF;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm, p_user, 'firm.trial_terms_accepted', 'firm', p_firm, jsonb_build_object('version', p_version));
END $$;
ALTER FUNCTION huis.record_trial_terms(uuid, uuid, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.record_trial_terms(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.record_trial_terms(uuid, uuid, text) TO huis_app;

CREATE FUNCTION huis.firms_trial_terms_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'huis_security' AND (
       NEW.trial_terms_version IS DISTINCT FROM OLD.trial_terms_version
       OR NEW.trial_terms_accepted_at IS DISTINCT FROM OLD.trial_terms_accepted_at) THEN
    RAISE EXCEPTION 'The accepted trial terms are recorded by Huis and can''t be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER firms_trial_terms_guard BEFORE UPDATE ON huis.firms
  FOR EACH ROW EXECUTE FUNCTION huis.firms_trial_terms_guard();
