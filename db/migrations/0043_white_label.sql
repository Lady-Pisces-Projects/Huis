-- Phase 10 part 5: white label for large firms (decided by Tracy, 12 November 2026: the firm's name, logo and
-- colours, shown to its staff and clients in the app; its own web address comes with production hosting).
--
-- Enterprise plan only: on any other plan nothing is shown (the settings are kept). Set by the firm's owner,
-- managing partners and firm administrators. Colours must stay readable (WCAG AA contrast, 4.5:1), checked here.
-- The logo is a PNG, JPEG or WebP image of at most 256 KB (checked by its first bytes, not its name); SVG is
-- refused because it can carry script. It is served only to people signed in to that firm.

CREATE TABLE huis.firm_branding (
  firm_id       uuid PRIMARY KEY REFERENCES huis.firms(id),
  display_name  text CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 80 AND display_name !~ '[[:cntrl:]]')),
  brand_color   text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$'),
  accent_color  text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
  logo          bytea CHECK (logo IS NULL OR octet_length(logo) BETWEEN 8 AND 262144),
  logo_type     text CHECK (logo_type IS NULL OR logo_type IN ('image/png', 'image/jpeg', 'image/webp')),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((logo IS NULL) = (logo_type IS NULL))
);
ALTER TABLE huis.firm_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.firm_branding FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.firm_branding FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.firm_branding TO huis_security;

-- WCAG relative luminance and contrast ratio of two #rrggbb colours.
CREATE FUNCTION huis.color_luminance(p text) RETURNS float8 LANGUAGE sql IMMUTABLE AS $$
  WITH c AS (SELECT ('x' || substr(p, 2, 2))::bit(8)::int / 255.0 AS r,
                    ('x' || substr(p, 4, 2))::bit(8)::int / 255.0 AS g,
                    ('x' || substr(p, 6, 2))::bit(8)::int / 255.0 AS b),
  l AS (SELECT CASE WHEN r <= 0.03928 THEN r / 12.92 ELSE power((r + 0.055) / 1.055, 2.4) END AS r,
               CASE WHEN g <= 0.03928 THEN g / 12.92 ELSE power((g + 0.055) / 1.055, 2.4) END AS g,
               CASE WHEN b <= 0.03928 THEN b / 12.92 ELSE power((b + 0.055) / 1.055, 2.4) END AS b FROM c)
  SELECT 0.2126 * r + 0.7152 * g + 0.0722 * b FROM l
$$;
CREATE FUNCTION huis.color_contrast(a text, b text) RETURNS float8 LANGUAGE sql IMMUTABLE AS $$
  SELECT (greatest(huis.color_luminance(a), huis.color_luminance(b)) + 0.05) / (least(huis.color_luminance(a), huis.color_luminance(b)) + 0.05)
$$;

CREATE FUNCTION huis.can_set_branding() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce(huis.app_role()::text, '') IN ('firm_owner', 'managing_partner', 'firm_admin')
$$;
ALTER FUNCTION huis.can_set_branding() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.can_set_branding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.can_set_branding() TO huis_security;

-- What everyone signed in to the firm sees (nothing unless the firm is on the Enterprise plan).
CREATE FUNCTION huis.my_firm_branding()
RETURNS TABLE (display_name text, brand_color text, accent_color text, has_logo boolean, version bigint, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT b.display_name, b.brand_color, b.accent_color, b.logo IS NOT NULL,
         (extract(epoch FROM b.updated_at) * 1000)::bigint, f.plan = 'enterprise'
    FROM huis.firms f JOIN huis.firm_branding b ON b.firm_id = f.id
   WHERE f.id = huis.current_firm_id() AND (f.plan = 'enterprise' OR huis.can_set_branding())
$$;
ALTER FUNCTION huis.my_firm_branding() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_branding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_branding() TO huis_app;

CREATE FUNCTION huis.my_firm_logo() RETURNS TABLE (logo bytea, logo_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT b.logo, b.logo_type FROM huis.firms f JOIN huis.firm_branding b ON b.firm_id = f.id
   WHERE f.id = huis.current_firm_id() AND b.logo IS NOT NULL AND (f.plan = 'enterprise' OR huis.can_set_branding())
$$;
ALTER FUNCTION huis.my_firm_logo() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.my_firm_logo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.my_firm_logo() TO huis_app;

CREATE FUNCTION huis.branding_check_editor() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF huis.current_firm_id() IS NULL OR NOT huis.can_set_branding() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF (SELECT plan FROM huis.firms WHERE id = huis.current_firm_id()) <> 'enterprise' THEN
    RAISE EXCEPTION 'White label is part of the Enterprise plan.' USING ERRCODE = 'HU403';
  END IF;
  RETURN huis.current_firm_id();
END $$;
ALTER FUNCTION huis.branding_check_editor() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.branding_check_editor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.branding_check_editor() TO huis_security;

CREATE FUNCTION huis.set_firm_branding(p_display_name text, p_brand_color text, p_accent_color text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.branding_check_editor();
        v_name text := nullif(btrim(p_display_name), '');
        v_brand text := lower(nullif(btrim(p_brand_color), ''));
        v_accent text := lower(nullif(btrim(p_accent_color), ''));
BEGIN
  IF v_name IS NOT NULL AND (length(v_name) > 80 OR v_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'The name can be up to 80 characters, on one line.' USING ERRCODE = 'HU403';
  END IF;
  IF (v_brand IS NOT NULL AND v_brand !~ '^#[0-9a-f]{6}$') OR (v_accent IS NOT NULL AND v_accent !~ '^#[0-9a-f]{6}$') THEN
    RAISE EXCEPTION 'Colours are written like #1d3557.' USING ERRCODE = 'HU403';
  END IF;
  -- The menu bar's text is white or dark, whichever reads better; either way it must reach 4.5:1.
  IF v_brand IS NOT NULL AND greatest(huis.color_contrast(v_brand, '#ffffff'), huis.color_contrast(v_brand, '#14213d')) < 4.5 THEN
    RAISE EXCEPTION 'That menu colour would make the menu hard to read. Choose a darker or lighter shade.' USING ERRCODE = 'HU403';
  END IF;
  -- Links and buttons sit on white.
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

CREATE FUNCTION huis.set_firm_logo(p_logo bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_firm uuid := huis.branding_check_editor(); v_type text;
BEGIN
  IF p_logo IS NULL THEN
    UPDATE huis.firm_branding SET logo = NULL, logo_type = NULL, updated_by = huis.current_user_id(), updated_at = now() WHERE firm_id = v_firm;
  ELSE
    IF octet_length(p_logo) > 262144 THEN RAISE EXCEPTION 'The logo can be up to 256 KB.' USING ERRCODE = 'HU403'; END IF;
    v_type := CASE
      WHEN substr(p_logo, 1, 8) = '\x89504e470d0a1a0a'::bytea THEN 'image/png'
      WHEN substr(p_logo, 1, 3) = '\xffd8ff'::bytea THEN 'image/jpeg'
      WHEN substr(p_logo, 1, 4) = '\x52494646'::bytea AND substr(p_logo, 9, 4) = '\x57454250'::bytea THEN 'image/webp'
    END;
    IF v_type IS NULL THEN RAISE EXCEPTION 'The logo must be a PNG, JPEG or WebP image.' USING ERRCODE = 'HU403'; END IF;
    INSERT INTO huis.firm_branding (firm_id, logo, logo_type, updated_by) VALUES (v_firm, p_logo, v_type, huis.current_user_id())
    ON CONFLICT (firm_id) DO UPDATE SET logo = EXCLUDED.logo, logo_type = EXCLUDED.logo_type, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (v_firm, huis.current_user_id(), 'firm.logo_changed', 'firm', v_firm,
            jsonb_build_object('removed', p_logo IS NULL, 'bytes', octet_length(p_logo), 'sha256', encode(public.digest(coalesce(p_logo, ''::bytea), 'sha256'), 'hex')));
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['set_firm_branding(text, text, text)', 'set_firm_logo(bytea)'] LOOP
    EXECUTE format('ALTER FUNCTION huis.%s OWNER TO huis_security', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION huis.%s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION huis.%s TO huis_app', fn);
  END LOOP;
END $$;
