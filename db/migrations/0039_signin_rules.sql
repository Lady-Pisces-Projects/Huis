-- Sign-in security: a firm can require that its staff sign in with the firm's own Microsoft 365 organization
-- or Google Workspace domain. Personal Gmail and Outlook accounts are then refused for firm staff, and the
-- firm's own account rules apply to every sign-in: its required multi-factor sign-in, password rules, and
-- switching off a departing employee's account (which ends their Huis access too).
--
-- Clients and other outside users (client, co-counsel, expert witness, authorized third party) are never held
-- to the rule: they sign in with their own accounts.
--
-- Where the organization comes from:
--   Microsoft: the tenant id in the verified ID token. Huis's Microsoft identity is "<tenant>:<user>", so the
--              database reads the tenant from the identity itself and never takes the app's word for it.
--   Google:    the "hd" claim in the verified ID token (Google: "You must check this claim when restricting access
--              to a resource to only members of certain domains"; absent for personal accounts). It isn't part of
--              Google's account id, so Huis records it at each sign-in in huis.identity_orgs, which the app can't
--              read or change except through huis.signin_accounts.
--
-- Huis does not claim to check multi-factor sign-in itself: Google's ID token doesn't say whether it was used,
-- and Microsoft's v2.0 ID token isn't documented to carry the amr claim reliably. The firm's own organization
-- enforces it; this rule makes sure every staff sign-in goes through that organization.

CREATE TABLE huis.identity_orgs (
  provider   text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  org        text NOT NULL CHECK (length(org) <= 253),   -- '' = no organization (a personal account)
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
REVOKE ALL ON huis.identity_orgs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON huis.identity_orgs TO huis_security;

CREATE TABLE huis.firm_signin_rules (
  firm_id    uuid PRIMARY KEY REFERENCES huis.firms(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  org        text NOT NULL CHECK (length(org) BETWEEN 1 AND 253),
  set_by     uuid NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON huis.firm_signin_rules FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.firm_signin_rules TO huis_security;

-- The personal Microsoft account "tenant" (Outlook.com, Hotmail, Xbox): never a firm's organization.
CREATE FUNCTION huis.microsoft_personal_tenant() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '9188040d-6c67-4c5b-b112-36a304b66dad' $$;

-- The organization of an identity: Microsoft's from the identity itself, Google's as last recorded ('' if unknown).
CREATE FUNCTION huis.identity_org(p_provider text, p_subject text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN p_provider = 'microsoft' AND p_subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
      THEN lower(split_part(p_subject, ':', 1))
    WHEN p_provider = 'google'
      THEN coalesce((SELECT o.org FROM huis.identity_orgs o WHERE o.provider = 'google' AND o.subject = p_subject), '')
    ELSE '' END
$$;
ALTER FUNCTION huis.identity_org(text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.identity_org(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.identity_org(text, text) TO huis_security;

-- May this person (role in firm, signing in with this identity) use the firm? Fails closed on anything missing.
CREATE FUNCTION huis.signin_allowed(p_firm_id uuid, p_role huis.firm_role, p_provider text, p_subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM huis.firm_signin_rules r WHERE r.firm_id = p_firm_id) THEN true
    WHEN p_role IS NOT NULL AND NOT huis.is_internal_role(p_role) THEN true
    ELSE EXISTS (SELECT 1 FROM huis.firm_signin_rules r
                  WHERE r.firm_id = p_firm_id AND r.provider = p_provider
                    AND r.org <> '' AND r.org = huis.identity_org(p_provider, p_subject))
  END
$$;
ALTER FUNCTION huis.signin_allowed(uuid, huis.firm_role, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.signin_allowed(uuid, huis.firm_role, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.signin_allowed(uuid, huis.firm_role, text, text) TO huis_security;

-- Records a Google identity's organization from its verified token (Microsoft's needs no record).
CREATE FUNCTION huis.record_identity_org(p_provider text, p_subject text, p_org text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_org text := lower(coalesce(p_org, ''));
BEGIN
  IF p_provider <> 'google' THEN RETURN; END IF;
  IF p_subject IS NULL OR p_subject !~ '^[0-9]{1,64}$' THEN RAISE EXCEPTION 'invalid identity'; END IF;
  IF v_org <> '' AND v_org !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
    RAISE EXCEPTION 'invalid organization';
  END IF;
  INSERT INTO huis.identity_orgs (provider, subject, org) VALUES ('google', p_subject, v_org)
    ON CONFLICT (provider, subject) DO UPDATE SET org = EXCLUDED.org, seen_at = now();
END $$;
ALTER FUNCTION huis.record_identity_org(text, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.record_identity_org(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.record_identity_org(text, text, text) TO huis_security;

-- Sign-in lookup with the firm rule: records the identity's organization, then lists its accounts with
-- whether each firm lets this identity in.
CREATE FUNCTION huis.signin_accounts(p_provider text, p_subject text, p_org text)
RETURNS TABLE (firm_id uuid, user_id uuid, firm_name text, role huis.firm_role, allowed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  PERFORM huis.record_identity_org(p_provider, p_subject, p_org);
  RETURN QUERY
    SELECT r.firm_id, r.user_id, r.firm_name, r.role, huis.signin_allowed(r.firm_id, r.role, p_provider, p_subject)
      FROM huis.resolve_identity(p_provider, p_subject) r;
END $$;
ALTER FUNCTION huis.signin_accounts(text, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.signin_accounts(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.signin_accounts(text, text, text) TO huis_app;
GRANT EXECUTE ON FUNCTION huis.resolve_identity(text, text) TO huis_security;

-- Checked at the start of every signed-in request (src/db/tenant.ts): turning the rule on ends the access of
-- staff who signed in some other way, at once.
CREATE FUNCTION huis.session_signin_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce((SELECT huis.signin_allowed(u.firm_id, u.role, u.auth_provider, u.auth_subject)
                     FROM huis.users u WHERE u.id = huis.current_user_id() AND u.firm_id = huis.current_firm_id()), false)
$$;
ALTER FUNCTION huis.session_signin_allowed() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.session_signin_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.session_signin_allowed() TO huis_app;

-- Accepting an invitation with the firm rule: a staff invitation can't be accepted with an account from
-- outside the firm's organization (it would link a personal account to the firm). Replaces the 3-argument form
-- for the app.
CREATE FUNCTION huis.accept_invitation(p_token text, p_provider text, p_subject text, p_org text)
RETURNS TABLE (firm_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE v_inv huis.user_invitations; v_role huis.firm_role;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR p_subject IS NULL OR p_provider IS NULL THEN RETURN; END IF;
  PERFORM huis.record_identity_org(p_provider, p_subject, p_org);
  SELECT * INTO v_inv FROM huis.user_invitations i
   WHERE i.token_hash = encode(public.digest(p_token, 'sha256'), 'hex')
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.role INTO v_role FROM huis.users u WHERE u.id = v_inv.user_id;
  IF NOT huis.signin_allowed(v_inv.firm_id, v_role, p_provider, p_subject) THEN
    RAISE EXCEPTION 'This firm requires its staff to sign in with the firm''s own Microsoft or Google account.' USING ERRCODE = 'HU403';
  END IF;
  RETURN QUERY SELECT a.firm_id, a.user_id FROM huis.accept_invitation(p_token, p_provider, p_subject) a;
END $$;
ALTER FUNCTION huis.accept_invitation(text, text, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.accept_invitation(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.accept_invitation(text, text, text, text) TO huis_app;
REVOKE EXECUTE ON FUNCTION huis.accept_invitation(text, text, text) FROM huis_app;
GRANT EXECUTE ON FUNCTION huis.accept_invitation(text, text, text) TO huis_security;
GRANT SELECT ON huis.user_invitations TO huis_security;

-- Who may set the rule: the firm's owner, managing partners and firm administrators.
CREATE FUNCTION huis.can_set_signin_rule() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce(huis.app_role()::text, '') IN ('firm_owner', 'managing_partner', 'firm_admin')
$$;
ALTER FUNCTION huis.can_set_signin_rule() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.can_set_signin_rule() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.can_set_signin_rule() TO huis_security;

-- The firm's rule and the staff it would leave out (for the Sign-in security page). Names and how each person
-- signs in only; nothing about any Matter.
CREATE FUNCTION huis.my_signin_rule()
RETURNS TABLE (rule_provider text, rule_org text, my_provider text, my_org text, user_id uuid, full_name text, user_provider text, user_org text, allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); v_me huis.users; r huis.firm_signin_rules;
BEGIN
  IF v_firm IS NULL OR NOT huis.can_set_signin_rule() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_me FROM huis.users u WHERE u.id = huis.current_user_id() AND u.firm_id = v_firm;
  SELECT * INTO r FROM huis.firm_signin_rules x WHERE x.firm_id = v_firm;
  RETURN QUERY
    SELECT r.provider, r.org, v_me.auth_provider, huis.identity_org(v_me.auth_provider, v_me.auth_subject),
           u.id, u.full_name, u.auth_provider,
           CASE WHEN u.auth_subject IS NULL THEN NULL ELSE huis.identity_org(u.auth_provider, u.auth_subject) END,
           CASE WHEN u.auth_subject IS NULL THEN NULL ELSE huis.signin_allowed(v_firm, u.role, u.auth_provider, u.auth_subject) END
      FROM huis.users u
     WHERE u.firm_id = v_firm AND u.status = 'active' AND huis.is_internal_role(u.role)
     ORDER BY u.full_name;
END $$;
ALTER FUNCTION huis.my_signin_rule() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_signin_rule() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_signin_rule() TO huis_app;

-- Sets or clears the rule. The organization is always the one the person setting it signed in with, so nobody
-- types an id, and nobody can lock themselves out: a personal account can't turn the rule on.
CREATE FUNCTION huis.set_signin_rule(p_provider text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.current_firm_id(); v_me huis.users; v_org text; old huis.firm_signin_rules;
BEGIN
  IF v_firm IS NULL OR NOT huis.can_set_signin_rule() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_me FROM huis.users u WHERE u.id = huis.current_user_id() AND u.firm_id = v_firm AND u.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO old FROM huis.firm_signin_rules x WHERE x.firm_id = v_firm FOR UPDATE;

  IF p_provider = 'any' THEN
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
  ELSE
    RAISE EXCEPTION 'unknown sign-in rule';
  END IF;

  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, v_me.id, 'firm.signin_rule_changed', 'firm', v_firm,
            jsonb_build_object('from', CASE WHEN old.firm_id IS NULL THEN jsonb_build_object('provider', 'any')
                                            ELSE jsonb_build_object('provider', old.provider, 'org', old.org) END,
                               'to', CASE WHEN v_org IS NULL THEN jsonb_build_object('provider', 'any')
                                          ELSE jsonb_build_object('provider', p_provider, 'org', v_org) END));
END $$;
ALTER FUNCTION huis.set_signin_rule(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.set_signin_rule(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.set_signin_rule(text) TO huis_app;
