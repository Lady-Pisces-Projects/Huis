-- Security review 29 (Google sign-in), concern 1: an invitation could be accepted by a direct link to the sign-in
-- start route, skipping the invitation page, so someone could be sent a "sign in to Huis" link that quietly
-- joined their account to a firm they didn't recognise. The invitation page now names the firm and the person
-- invited, and accepting is a button press on that page (a POST checked to come from Huis itself).
--
-- What the page may show for a valid, unused invitation: the firm's name, the invited person's name and role.
-- Nothing else, and nothing for a token that is wrong, used, revoked or expired.
CREATE FUNCTION huis.invitation_preview(p_token text, OUT firm_name text, OUT invitee_name text, OUT role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
  SELECT f.name, u.full_name, u.role::text
    FROM huis.user_invitations i
    JOIN huis.users u ON u.id = i.user_id
    JOIN huis.firms f ON f.id = i.firm_id
   WHERE p_token IS NOT NULL AND length(p_token) >= 32
     AND i.token_hash = encode(public.digest(p_token, 'sha256'), 'hex')
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     AND u.status = 'active' AND u.auth_subject IS NULL
$$;
ALTER FUNCTION huis.invitation_preview(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.invitation_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.invitation_preview(text) TO huis_app;
