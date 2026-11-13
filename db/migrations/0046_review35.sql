-- Security review 35: how the Phase 10 and 11 features work together (end-to-end review on main).
--
-- R35-1: with a sign-in rule on, a firm administrator could disable or demote the only owner the rule lets in,
--        leaving owners who are all refused (review 31 only checked this when the rule was turned on). Now, while
--        a rule exists, the last owner the rule allows can't be disabled or demoted (checked in the database).
-- R35-2: an unused "sign in again" link kept working after the rule was turned off, so whoever held it could move
--        an existing account (with its Matter access) to any account. Accepting one now needs the rule still on
--        and the person still refused by it, and turning the rule off revokes the outstanding links.
-- R35-3: cloud-drive imports and listings, and email filings, queued by someone the rule now refuses still ran
--        as them. They now stop, like mailbox sync (0041).

-- R35-1 ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION huis.firm_has_allowed_owner(p_firm_id uuid, p_except uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM huis.users u WHERE u.firm_id = p_firm_id AND u.id <> p_except AND u.role = 'firm_owner'
                   AND u.status = 'active' AND u.auth_subject IS NOT NULL
                   AND huis.signin_allowed(p_firm_id, u.role, u.auth_provider, u.auth_subject))
$$;
ALTER FUNCTION huis.firm_has_allowed_owner(uuid, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_has_allowed_owner(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.firm_has_allowed_owner(uuid, uuid) TO huis_app, huis_security;

CREATE FUNCTION huis.firm_rule_exists(p_firm_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM huis.firm_signin_rules r WHERE r.firm_id = p_firm_id)
$$;
ALTER FUNCTION huis.firm_rule_exists(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.firm_rule_exists(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.firm_rule_exists(uuid) TO huis_app, huis_security;

CREATE FUNCTION huis.users_owner_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'firm_owner' AND OLD.status = 'active' AND (NEW.role <> 'firm_owner' OR NEW.status <> 'active')
     AND huis.firm_rule_exists(OLD.firm_id) AND NOT huis.firm_has_allowed_owner(OLD.firm_id, OLD.id) THEN
    RAISE EXCEPTION 'This is the only owner who can sign in under the firm''s sign-in rule. Make another owner who signs in with the firm''s account first, or turn the rule off.'
      USING ERRCODE = 'HU403';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_owner_rule_guard BEFORE UPDATE OF role, status ON huis.users
  FOR EACH ROW EXECUTE FUNCTION huis.users_owner_rule_guard();

-- R35-2 ----------------------------------------------------------------------------------------------------------
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

  -- A "sign in again" link only does its job: the rule is still on and still refuses the person's current sign-in.
  IF u.status <> 'active' OR u.auth_subject IS NULL OR NOT huis.is_internal_role(u.role)
     OR NOT huis.firm_rule_exists(v_inv.firm_id)
     OR huis.signin_allowed(v_inv.firm_id, u.role, u.auth_provider, u.auth_subject)
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

-- Turning the rule off revokes the outstanding "sign in again" links.
CREATE FUNCTION huis.firm_signin_rules_revoke_relinks() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  UPDATE huis.user_invitations SET revoked_at = now()
   WHERE firm_id = OLD.firm_id AND relink AND accepted_at IS NULL AND revoked_at IS NULL;
  RETURN OLD;
END $$;
ALTER FUNCTION huis.firm_signin_rules_revoke_relinks() OWNER TO huis_security;
CREATE TRIGGER firm_signin_rules_revoke_relinks AFTER DELETE ON huis.firm_signin_rules
  FOR EACH ROW EXECUTE FUNCTION huis.firm_signin_rules_revoke_relinks();

-- R35-3 ----------------------------------------------------------------------------------------------------------
-- The requester (or account owner) must still be let in by the firm's sign-in rule. Added to the existing checks.
DO $$
DECLARE def text; patched text;
BEGIN
  -- Imports and email filings: the requester check.
  FOR def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'huis' AND p.proname IN ('integration_import_allowed', 'filing_still_allowed') LOOP
    patched := replace(def,
      $x$OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only' THEN RETURN false; END IF;$x$,
      $x$OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only'
     OR NOT huis.signin_allowed(u.firm_id, u.role, u.auth_provider, u.auth_subject) THEN RETURN false; END IF;$x$);
    IF patched = def THEN RAISE EXCEPTION 'could not add the sign-in rule check'; END IF;
    EXECUTE patched;
  END LOOP;
  -- Listings: the account owner check.
  SELECT pg_get_functiondef(p.oid) INTO def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'huis' AND p.proname = 'worker_claim_integration_listing';
  patched := replace(def,
    $x$AND huis.is_internal_role(u.role) AND u.role <> 'read_only') THEN$x$,
    $x$AND huis.is_internal_role(u.role) AND u.role <> 'read_only'
                   AND huis.signin_allowed(u.firm_id, u.role, u.auth_provider, u.auth_subject)) THEN$x$);
  IF patched = def THEN RAISE EXCEPTION 'could not add the sign-in rule check to listings'; END IF;
  EXECUTE patched;
END $$;
GRANT SELECT, UPDATE ON huis.user_invitations TO huis_security;

-- Lockout recovery (review 35): if a firm can no longer sign in under its rule (for example its Google Workspace
-- domain changed), Huis staff can turn the rule off from the admin portal, with a note. Account setting only.
CREATE FUNCTION huis.platform_signin_rule(p_firm_id uuid) RETURNS TABLE (provider text, org text, set_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT r.provider, r.org, r.set_at FROM huis.firm_signin_rules r WHERE r.firm_id = p_firm_id
$$;
CREATE FUNCTION huis.platform_clear_signin_rule(p_staff text, p_firm_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE r huis.firm_signin_rules;
BEGIN
  PERFORM huis.platform_check_note(p_staff, p_note);
  SELECT * INTO r FROM huis.firm_signin_rules x WHERE x.firm_id = p_firm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This firm has no sign-in rule.' USING ERRCODE = 'HU400'; END IF;
  DELETE FROM huis.firm_signin_rules WHERE firm_id = p_firm_id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (p_firm_id, NULL, 'firm.signin_rule_changed', 'firm', p_firm_id, jsonb_build_object('by', 'Huis', 'note', p_note,
      'from', jsonb_build_object('provider', r.provider, 'org', r.org), 'to', jsonb_build_object('provider', 'any')));
  INSERT INTO huis.platform_audit (staff, action, firm_id, note, detail)
    VALUES (p_staff, 'firm.clear_signin_rule', p_firm_id, p_note, jsonb_build_object('provider', r.provider, 'org', r.org));
END $$;
ALTER FUNCTION huis.platform_signin_rule(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.platform_clear_signin_rule(text, uuid, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.platform_signin_rule(uuid), huis.platform_clear_signin_rule(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.platform_signin_rule(uuid), huis.platform_clear_signin_rule(text, uuid, text) TO huis_platform;
