-- Security review 33 (Phase 10 part 5, white label).
--
-- R33-1: branding could still be changed after Enterprise access ended, or while Huis had suspended the firm.
--        Changing it now also needs the firm active with access (huis.firm_access_ended_at empty).
-- R33-2: the menu name accepted invisible, direction-reversing and line-separator characters (a name blank to
--        the eye, "Smith<RLO>LLP" shown reversed). Those are refused, Unicode spaces are trimmed, and the name
--        needs a letter or digit.
-- R33-3: a firm that left Enterprise could never delete its saved logo or name. Removing is now allowed on any
--        plan; setting stays Enterprise only.
-- Also: PNG logos larger than 4000 pixels on a side are refused (a tiny file can unpack to gigabytes); JPEG and
--       WebP sizes are checked by the app (src/services/branding.ts).

CREATE OR REPLACE FUNCTION huis.branding_check_editor() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE f huis.firms;
BEGIN
  IF huis.current_firm_id() IS NULL OR NOT huis.can_set_branding() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO f FROM huis.firms WHERE id = huis.current_firm_id();
  IF f.plan <> 'enterprise' OR f.status <> 'active' OR huis.firm_access_ended_at(f.id) IS NOT NULL THEN
    RAISE EXCEPTION 'White label is part of the Enterprise plan.' USING ERRCODE = 'HU403';
  END IF;
  RETURN f.id;
END $$;

-- Removing needs only the right role (any plan).
CREATE FUNCTION huis.branding_check_remover() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF huis.current_firm_id() IS NULL OR NOT huis.can_set_branding() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  RETURN huis.current_firm_id();
END $$;
ALTER FUNCTION huis.branding_check_remover() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.branding_check_remover() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.branding_check_remover() TO huis_security;

-- Invisible and direction-changing characters (format characters), line and paragraph separators, soft hyphen.
CREATE FUNCTION huis.has_hidden_chars(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p ~ '[­؜᠎​-‏ -‮⁠-⁯﻿￹-￻[:cntrl:]]'
$$;

CREATE OR REPLACE FUNCTION huis.set_firm_branding(p_display_name text, p_brand_color text, p_accent_color text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid;
        v_name text := nullif(regexp_replace(coalesce(p_display_name, ''), '^[\s   -   　]+|[\s   -   　]+$', '', 'g'), '');
        v_brand text := lower(nullif(btrim(p_brand_color), ''));
        v_accent text := lower(nullif(btrim(p_accent_color), ''));
BEGIN
  -- A name typed as nothing but invisible spaces is refused, not taken as clearing it.
  IF v_name IS NULL AND btrim(coalesce(p_display_name, '')) <> '' THEN
    RAISE EXCEPTION 'The name can be up to 80 characters, on one line, with letters or digits and no hidden characters.' USING ERRCODE = 'HU403';
  END IF;
  -- Clearing everything is allowed on any plan (R33-3); setting anything needs Enterprise with access.
  v_firm := CASE WHEN v_name IS NULL AND v_brand IS NULL AND v_accent IS NULL THEN huis.branding_check_remover() ELSE huis.branding_check_editor() END;
  IF v_name IS NOT NULL AND (length(v_name) > 80 OR huis.has_hidden_chars(v_name) OR v_name !~ '[[:alnum:]]') THEN
    RAISE EXCEPTION 'The name can be up to 80 characters, on one line, with letters or digits and no hidden characters.' USING ERRCODE = 'HU403';
  END IF;
  IF (v_brand IS NOT NULL AND v_brand !~ '^#[0-9a-f]{6}$') OR (v_accent IS NOT NULL AND v_accent !~ '^#[0-9a-f]{6}$') THEN
    RAISE EXCEPTION 'Colours are written like #1d3557.' USING ERRCODE = 'HU403';
  END IF;
  IF v_brand IS NOT NULL AND greatest(huis.color_contrast(v_brand, '#ffffff'), huis.color_contrast(v_brand, '#14213d')) < 4.5 THEN
    RAISE EXCEPTION 'That menu colour would make the menu hard to read. Choose a darker or lighter shade.' USING ERRCODE = 'HU403';
  END IF;
  IF v_accent IS NOT NULL AND huis.color_contrast(v_accent, '#ffffff') < 4.5 THEN
    RAISE EXCEPTION 'That link colour would be hard to read on white. Choose a darker shade.' USING ERRCODE = 'HU403';
  END IF;
  INSERT INTO huis.firm_branding (firm_id, display_name, brand_color, accent_color, updated_by)
    VALUES (v_firm, v_name, v_brand, v_accent, huis.current_user_id())
  ON CONFLICT (firm_id) DO UPDATE SET display_name = EXCLUDED.display_name, brand_color = EXCLUDED.brand_color,
    accent_color = EXCLUDED.accent_color, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, huis.current_user_id(), 'firm.branding_changed', 'firm', v_firm,
            jsonb_build_object('display_name', v_name, 'brand_color', v_brand, 'accent_color', v_accent));
END $$;

CREATE OR REPLACE FUNCTION huis.set_firm_logo(p_logo bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid; v_type text; w bigint; h bigint;
BEGIN
  IF p_logo IS NULL THEN
    v_firm := huis.branding_check_remover();
    UPDATE huis.firm_branding SET logo = NULL, logo_type = NULL, updated_by = huis.current_user_id(), updated_at = now() WHERE firm_id = v_firm;
  ELSE
    v_firm := huis.branding_check_editor();
    IF octet_length(p_logo) > 262144 THEN RAISE EXCEPTION 'The logo can be up to 256 KB.' USING ERRCODE = 'HU403'; END IF;
    v_type := CASE
      WHEN substr(p_logo, 1, 8) = '\x89504e470d0a1a0a'::bytea THEN 'image/png'
      WHEN substr(p_logo, 1, 3) = '\xffd8ff'::bytea THEN 'image/jpeg'
      WHEN substr(p_logo, 1, 4) = '\x52494646'::bytea AND substr(p_logo, 9, 4) = '\x57454250'::bytea THEN 'image/webp'
    END;
    IF v_type IS NULL THEN RAISE EXCEPTION 'The logo must be a PNG, JPEG or WebP image.' USING ERRCODE = 'HU403'; END IF;
    IF v_type = 'image/png' THEN
      IF octet_length(p_logo) < 24 OR substr(p_logo, 13, 4) <> '\x49484452'::bytea THEN
        RAISE EXCEPTION 'The logo must be a PNG, JPEG or WebP image.' USING ERRCODE = 'HU403';
      END IF;
      w := (get_byte(p_logo, 16)::bigint << 24) | (get_byte(p_logo, 17) << 16) | (get_byte(p_logo, 18) << 8) | get_byte(p_logo, 19);
      h := (get_byte(p_logo, 20)::bigint << 24) | (get_byte(p_logo, 21) << 16) | (get_byte(p_logo, 22) << 8) | get_byte(p_logo, 23);
      IF w < 1 OR h < 1 OR w > 4000 OR h > 4000 THEN
        RAISE EXCEPTION 'The logo can be up to 4000 pixels wide and tall.' USING ERRCODE = 'HU403';
      END IF;
    END IF;
    INSERT INTO huis.firm_branding (firm_id, logo, logo_type, updated_by) VALUES (v_firm, p_logo, v_type, huis.current_user_id())
    ON CONFLICT (firm_id) DO UPDATE SET logo = EXCLUDED.logo, logo_type = EXCLUDED.logo_type, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, huis.current_user_id(), 'firm.logo_changed', 'firm', v_firm,
            jsonb_build_object('removed', p_logo IS NULL, 'bytes', octet_length(p_logo), 'sha256', encode(public.digest(coalesce(p_logo, ''::bytea), 'sha256'), 'hex')));
END $$;

-- Branding rows go with their firm.
ALTER TABLE huis.firm_branding DROP CONSTRAINT firm_branding_firm_id_fkey;
ALTER TABLE huis.firm_branding ADD CONSTRAINT firm_branding_firm_id_fkey FOREIGN KEY (firm_id) REFERENCES huis.firms(id) ON DELETE CASCADE;
