-- Security review 31 (sign-in security, 0039).
--
-- R31-1: an administrator or managing partner could turn the rule on with an organization no owner uses, locking
--        every owner out. A rule must leave at least one active owner able to sign in.
-- R31-2: staff the rule left out could never come back with the firm's account (their user row is linked to the
--        old identity). A firm owner can now give such a person a one-time "sign in again" link, accepted only with
--        an account that meets the rule. Owner only, because accepting re-links an existing account, with its Matter
--        access, to a new sign-in.
-- R31-3: the rule only suspended sessions: turning it off brought old cookies back, and signing out under the rule
--        ended nothing. Turning the rule on now ends the sessions of the staff it leaves out, and re-linking ends
--        the old sessions too. (Sign-out ends sessions without the rule check: src/db/tenant.ts.)

-- R31-2: a re-link invitation can only be created by huis_security (through issue_relink_invitation).
ALTER TABLE huis.user_invitations ADD COLUMN relink boolean NOT NULL DEFAULT false;
CREATE FUNCTION huis.user_invitations_relink_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.relink AND current_user <> 'huis_security' AND (TG_OP = 'INSERT' OR NOT OLD.relink) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_invitations_relink_guard BEFORE INSERT OR UPDATE ON huis.user_invitations
  FOR EACH ROW EXECUTE FUNCTION huis.user_invitations_relink_guard();
GRANT INSERT, UPDATE ON huis.user_invitations TO huis_security;
GRANT UPDATE ON huis.users TO huis_security;

CREATE FUNCTION huis.issue_relink_invitation(p_user_id uuid, p_token_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); u huis.users;
BEGIN
  IF v_firm IS NULL OR coalesce(huis.app_role()::text, '') <> 'firm_owner' THEN
    RAISE EXCEPTION 'Only a firm owner can give someone a new sign-in link.' USING ERRCODE = 'HU403';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid token'; END IF;
  SELECT * INTO u FROM huis.users x WHERE x.id = p_user_id AND x.firm_id = v_firm FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found.' USING ERRCODE = 'HU403'; END IF;
  IF u.status <> 'active' OR u.auth_subject IS NULL OR NOT huis.is_internal_role(u.role)
     OR huis.signin_allowed(v_firm, u.role, u.auth_provider, u.auth_subject) THEN
    RAISE EXCEPTION 'A new sign-in link is only for staff the firm''s sign-in rule leaves out.' USING ERRCODE = 'HU403';
  END IF;
  UPDATE huis.user_invitations SET revoked_at = now() WHERE user_id = u.id AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO huis.user_invitations (firm_id, user_id, token_hash, created_by, expires_at, relink)
    VALUES (v_firm, u.id, p_token_hash, huis.current_user_id(), now() + interval '7 days', true);
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id)
    VALUES (v_firm, huis.current_user_id(), 'user.relink_invitation_issued', 'user', u.id);
END $$;
ALTER FUNCTION huis.issue_relink_invitation(uuid, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.issue_relink_invitation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.issue_relink_invitation(uuid, text) TO huis_app;

-- Accepting: ordinary invitations as before; a re-link invitation moves the account to the new sign-in only if it
-- meets the rule, ends the old sessions and is audited.
CREATE OR REPLACE FUNCTION huis.accept_invitation(p_token text, p_provider text, p_subject text, p_org text)
RETURNS TABLE (firm_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE v_inv huis.user_invitations; u huis.users;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR p_subject IS NULL OR p_provider IS NULL THEN RETURN; END IF;
  PERFORM huis.record_identity_org(p_provider, p_subject, p_org);
  SELECT * INTO v_inv FROM huis.user_invitations i
   WHERE i.token_hash = encode(public.digest(p_token, 'sha256'), 'hex')
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO u FROM huis.users x WHERE x.id = v_inv.user_id FOR UPDATE;
  IF NOT huis.signin_allowed(v_inv.firm_id, u.role, p_provider, p_subject) THEN
    RAISE EXCEPTION 'This firm requires its staff to sign in with the firm''s own Microsoft or Google account.' USING ERRCODE = 'HU403';
  END IF;
  IF NOT v_inv.relink THEN
    RETURN QUERY SELECT a.firm_id, a.user_id FROM huis.accept_invitation(p_token, p_provider, p_subject) a;
    RETURN;
  END IF;

  IF u.status <> 'active' OR u.auth_subject IS NULL OR NOT huis.is_internal_role(u.role)
     OR EXISTS (SELECT 1 FROM huis.users x WHERE x.firm_id = v_inv.firm_id AND x.auth_provider = p_provider AND x.auth_subject = p_subject) THEN
    RETURN;
  END IF;
  UPDATE huis.users SET auth_provider = p_provider, auth_subject = p_subject, session_version = session_version + 1 WHERE id = u.id;
  UPDATE huis.user_invitations SET accepted_at = now() WHERE id = v_inv.id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_inv.firm_id, u.id, 'user.relinked', 'user', u.id,
            jsonb_build_object('from_provider', u.auth_provider, 'to_provider', p_provider, 'issued_by', v_inv.created_by));
  RETURN QUERY SELECT v_inv.firm_id, u.id;
END $$;

-- The invitation page shows re-link invitations too.
CREATE OR REPLACE FUNCTION huis.invitation_preview(p_token text, OUT firm_name text, OUT invitee_name text, OUT role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
  SELECT f.name, u.full_name, u.role::text
    FROM huis.user_invitations i
    JOIN huis.users u ON u.id = i.user_id
    JOIN huis.firms f ON f.id = i.firm_id
   WHERE p_token IS NOT NULL AND length(p_token) >= 32
     AND i.token_hash = encode(public.digest(p_token, 'sha256'), 'hex')
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     AND u.status = 'active' AND (u.auth_subject IS NULL OR i.relink)
$$;

-- R31-1 and R31-3.
CREATE OR REPLACE FUNCTION huis.set_signin_rule(p_provider text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); v_me huis.users; v_org text; old huis.firm_signin_rules; v_out int := 0;
BEGIN
  IF v_firm IS NULL OR NOT huis.can_set_signin_rule() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_me FROM huis.users u WHERE u.id = huis.current_user_id() AND u.firm_id = v_firm AND u.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO old FROM huis.firm_signin_rules x WHERE x.firm_id = v_firm FOR UPDATE;

  IF p_provider = 'any' THEN
    IF old.firm_id IS NULL THEN RETURN; END IF;
    DELETE FROM huis.firm_signin_rules x WHERE x.firm_id = v_firm;
    v_org := NULL;
  ELSIF p_provider IN ('microsoft', 'google') THEN
    IF v_me.auth_provider IS DISTINCT FROM p_provider THEN
      RAISE EXCEPTION 'Sign in with your firm''s % account to turn this on.', CASE p_provider WHEN 'microsoft' THEN 'Microsoft 365' ELSE 'Google Workspace' END
        USING ERRCODE = 'HU403';
    END IF;
    v_org := huis.identity_org(v_me.auth_provider, v_me.auth_subject);
    IF v_org = '' OR v_org = huis.microsoft_personal_tenant() THEN
      RAISE EXCEPTION 'You signed in with a personal account. Sign in with your firm''s own % account to turn this on.',
        CASE p_provider WHEN 'microsoft' THEN 'Microsoft 365' ELSE 'Google Workspace' END USING ERRCODE = 'HU403';
    END IF;
    INSERT INTO huis.firm_signin_rules (firm_id, provider, org, set_by) VALUES (v_firm, p_provider, v_org, v_me.id)
      ON CONFLICT (firm_id) DO UPDATE SET provider = EXCLUDED.provider, org = EXCLUDED.org, set_by = EXCLUDED.set_by, set_at = now();
    -- R31-1: never lock out every owner.
    IF NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.firm_id = v_firm AND u.role = 'firm_owner' AND u.status = 'active'
                     AND u.auth_subject IS NOT NULL AND huis.signin_allowed(v_firm, u.role, u.auth_provider, u.auth_subject)) THEN
      RAISE EXCEPTION 'No firm owner signs in with this account''s organization, so this would lock every owner out. Ask an owner to turn it on.'
        USING ERRCODE = 'HU403';
    END IF;
    -- R31-3: end the sessions of the staff it leaves out (they don't come back if the rule is turned off later).
    WITH out AS (
      UPDATE huis.users u SET session_version = session_version + 1
       WHERE u.firm_id = v_firm AND u.status = 'active' AND u.auth_subject IS NOT NULL AND huis.is_internal_role(u.role)
         AND NOT huis.signin_allowed(v_firm, u.role, u.auth_provider, u.auth_subject)
      RETURNING 1)
    SELECT count(*) INTO v_out FROM out;
  ELSE
    RAISE EXCEPTION 'unknown sign-in rule';
  END IF;

  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, v_me.id, 'firm.signin_rule_changed', 'firm', v_firm,
            jsonb_build_object('from', CASE WHEN old.firm_id IS NULL THEN jsonb_build_object('provider', 'any')
                                            ELSE jsonb_build_object('provider', old.provider, 'org', old.org) END,
                               'to', CASE WHEN v_org IS NULL THEN jsonb_build_object('provider', 'any')
                                          ELSE jsonb_build_object('provider', p_provider, 'org', v_org) END,
                               'staff_signed_out', v_out));
END $$;
