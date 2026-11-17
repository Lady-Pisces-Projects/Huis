-- Security review 28 (the trial rules of 11 November 2026 and reading a case description).
--
-- R28-1: any staff member could create "Huis suggested" Case DNA items from any note they wrote, with whatever
--        label, kind or date they liked (the cited words didn't have to support it). Now: only a note titled
--        "Case description"; a person's, organization's or event's label IS the cited words (set here, not by the
--        caller); a claim must be one of the fixed claims the rules can suggest; an event's date must appear in
--        its words; and each reading is in the audit log.
-- R28-2: one description could be replayed into thousands of suggestions, filling the Matter's 2,000 cap so
--        Huis stopped suggesting anything from evidence. Now: one reading per note, at most 40 suggestions, and
--        the cap is checked for each one.
-- R28-3: deleting your own Matter Brain answers or agent turns gave trial AI questions back. Questions asked are
--        now counted in a tally that only ever grows.

-- ---------------------------------------------------------------------------
-- R28-3: the tally of AI questions asked (never reduced; the app can't read or change it).
-- ---------------------------------------------------------------------------
CREATE TABLE huis.ai_question_tally (
  id        bigserial PRIMARY KEY,
  firm_id   uuid NOT NULL REFERENCES huis.firms(id),
  asked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_question_tally_firm ON huis.ai_question_tally (firm_id, asked_at);
REVOKE ALL ON huis.ai_question_tally FROM PUBLIC;
GRANT SELECT, INSERT ON huis.ai_question_tally TO huis_security;
GRANT USAGE ON SEQUENCE huis.ai_question_tally_id_seq TO huis_security;

INSERT INTO huis.ai_question_tally (firm_id, asked_at)
  SELECT firm_id, created_at FROM huis.brain_answers
  UNION ALL SELECT firm_id, created_at FROM huis.ai_agent_turns;

CREATE FUNCTION huis.ai_question_tally_add() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  INSERT INTO huis.ai_question_tally (firm_id) VALUES (NEW.firm_id);
  RETURN NULL;
END $$;
ALTER FUNCTION huis.ai_question_tally_add() OWNER TO huis_security;
CREATE TRIGGER brain_answers_tally AFTER INSERT ON huis.brain_answers FOR EACH ROW EXECUTE FUNCTION huis.ai_question_tally_add();
CREATE TRIGGER ai_agent_turns_tally AFTER INSERT ON huis.ai_agent_turns FOR EACH ROW EXECUTE FUNCTION huis.ai_question_tally_add();

CREATE OR REPLACE FUNCTION huis.firm_ai_questions_this_month(p_firm_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT count(*)::int FROM huis.ai_question_tally q, huis.firms f
   WHERE f.id = p_firm_id AND q.firm_id = p_firm_id
     AND q.asked_at >= CASE WHEN f.plan = 'trial' THEN f.created_at
                            ELSE date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END
$$;

-- ---------------------------------------------------------------------------
-- R28-1, R28-2: reading a case description.
-- ---------------------------------------------------------------------------
CREATE TABLE huis.case_description_runs (
  note_id    uuid PRIMARY KEY REFERENCES huis.matter_notes(id) ON DELETE CASCADE,
  firm_id    uuid NOT NULL REFERENCES huis.firms(id),
  matter_id  uuid NOT NULL,
  run_at     timestamptz NOT NULL DEFAULT now(),
  suggested  int NOT NULL DEFAULT 0
);
REVOKE ALL ON huis.case_description_runs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON huis.case_description_runs TO huis_security;

-- The claims src/dna/describe.ts can suggest (CLAIM_LABELS); test/security-review-28.test.ts keeps them in step.
CREATE FUNCTION huis.case_description_claims() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['FMLA retaliation', 'FMLA interference', 'Title VII retaliation', 'ADA disability discrimination',
               'Wrongful termination in violation of public policy (Utah)', 'Breach of contract (Utah)',
               'Negligence (personal injury)', 'Medical malpractice', 'Fraud or misrepresentation',
               'Divorce or legal separation', 'Child custody and parent-time', 'Child support or alimony', 'Unpaid wages']
$$;

-- Does the passage write this date? (Its year and day, and its month by name or number.)
CREATE FUNCTION huis.passage_has_date(p_quote text, p_date date) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_quote ~ ('\m' || extract(year FROM p_date)::int::text || '\M')
     AND p_quote ~ ('\m0?' || extract(day FROM p_date)::int::text || '(st|nd|rd|th)?\M')
     AND (p_quote ~* ('\m' || left(trim(to_char(p_date, 'month')), 3))
          OR p_quote ~ ('\m0?' || extract(month FROM p_date)::int::text || '[/-]')
          OR p_quote ~ ('-0?' || extract(month FROM p_date)::int::text || '-'))
$$;

DROP FUNCTION huis.suggest_from_case_description(uuid, jsonb);
CREATE FUNCTION huis.suggest_from_case_description(p_note_id uuid, p_items jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  x huis.matter_notes;
  v_text text;
  e jsonb;
  v_kind text; v_start int; v_end int; v_quote text; v_label text; v_node uuid; v_date date;
  v_existing int;
  n int := 0;
  v_seen int := 0;
BEGIN
  SELECT * INTO x FROM huis.matter_notes WHERE id = p_note_id;
  IF NOT FOUND OR x.firm_id IS DISTINCT FROM huis.current_firm_id() OR x.author_id IS DISTINCT FROM huis.current_user_id()
     OR NOT coalesce(huis.is_internal_role(huis.app_role()), false) OR NOT huis.dna_writable(x.matter_id)
     OR x.title <> 'Case description' THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'invalid suggestions'; END IF;
  -- One reading per description (a second is refused, so it can't be replayed).
  BEGIN
    INSERT INTO huis.case_description_runs (note_id, firm_id, matter_id) VALUES (x.id, x.firm_id, x.matter_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This case description has already been read.' USING ERRCODE = 'HU409';
  END;
  v_text := x.title || E'\n\n' || x.body;
  v_existing := (SELECT count(*) FROM huis.dna_nodes WHERE matter_id = x.matter_id AND origin = 'huis' AND status = 'suggested');

  FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_seen := v_seen + 1;
    EXIT WHEN v_seen > 40 OR v_existing + n >= 2000;
    BEGIN
      v_kind := e->>'kind';
      CONTINUE WHEN v_kind NOT IN ('event', 'person', 'organization', 'claim');
      v_start := (e->>'start')::int; v_end := (e->>'end')::int;
      CONTINUE WHEN v_start IS NULL OR v_end IS NULL OR v_start < length(x.title) + 2 OR v_end <= v_start OR v_end > length(v_text);
      v_quote := left(btrim(regexp_replace(substr(v_text, v_start + 1, v_end - v_start), '\s+', ' ', 'g')), 1500);
      CONTINUE WHEN v_quote = '';
      v_date := NULL;
      IF v_kind = 'claim' THEN
        -- A claim is one of the fixed few the rules suggest; its quote is the words that pointed to it.
        v_label := btrim(coalesce(e->>'label', ''));
        CONTINUE WHEN NOT v_label = ANY (huis.case_description_claims()) OR length(v_quote) > 200;
      ELSIF v_kind = 'event' THEN
        v_date := (e->>'date')::date;
        CONTINUE WHEN v_date IS NULL OR NOT huis.passage_has_date(v_quote, v_date);
        v_label := left(v_quote, 300);
      ELSE
        -- A person or organization is named by exactly the words cited.
        CONTINUE WHEN length(v_quote) > 120;
        v_label := v_quote;
      END IF;
      v_node := NULL;
      INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, origin_key)
        VALUES (x.firm_id, x.matter_id, v_kind, v_label, v_date, 'suggested', 'huis',
                format('description:%s:%s:%s', x.id, v_kind, v_start))
        ON CONFLICT (matter_id, origin_key) DO NOTHING
        RETURNING id INTO v_node;
      IF v_node IS NOT NULL THEN
        INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, note_id, char_start, char_end, quote)
          VALUES (x.firm_id, x.matter_id, v_node, x.id, v_start, v_end, v_quote);
        n := n + 1;
      END IF;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END LOOP;

  UPDATE huis.case_description_runs SET suggested = n WHERE note_id = x.id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (x.firm_id, huis.current_user_id(), 'case_description.read', 'note', x.id,
            jsonb_build_object('matter_id', x.matter_id, 'suggested', n));
  RETURN n;
END $$;
ALTER FUNCTION huis.suggest_from_case_description(uuid, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.suggest_from_case_description(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.suggest_from_case_description(uuid, jsonb) TO huis_app;
