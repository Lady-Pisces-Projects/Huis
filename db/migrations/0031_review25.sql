-- Security review 25 (Phase 10 part 3: firm billing).
--
-- R25-1: an item taken off (or changed on, or added to) a draft while that draft was being issued could end up
--        both billed and unbilled, or locked with different content from what was billed. Changes to an item
--        now wait for an issue in progress (and are refused once it's issued), and issuing locks its items.
-- R25-2: a timekeeper could undo a billing manager's rate on their own entry (by changing the rate or the date,
--        which re-read the standard rate). Only billing staff change an entry's rate now.
-- R25-3: a lead attorney (not billing staff) editing a colleague's time wiped its rate to $0. Same fix.
-- R25-4: a draft whose items had all been made non-billable was issued as a numbered $0 invoice with no lines.
--        Non-billable items leave the draft when it's issued, and an invoice with nothing to bill isn't issued.
-- R25-5: colleagues' rates could be read from the rate copied onto each time entry. The rate (and so the
--        amount) of other people's time is now only for billing staff and those who invoice the Matter.
-- R25-6: a timekeeper who can't invoice could move their own items on and off drafts. Only invoicers can.

-- R25-1: lock the invoice rows an item change depends on (waits for an issue in progress).
CREATE OR REPLACE FUNCTION huis.invoice_locked(p_invoice_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN false; END IF;
  SELECT status INTO v_status FROM huis.invoices WHERE id = p_invoice_id FOR SHARE;
  RETURN coalesce(v_status <> 'draft', false);
END $$;

CREATE OR REPLACE FUNCTION huis.time_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF huis.invoice_locked(OLD.invoice_id) THEN RAISE EXCEPTION 'This time is on an issued invoice and can''t be changed.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    IF NEW.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'New time starts unbilled.'; END IF;
    IF NEW.rate_cents IS NULL OR NOT huis.is_billing_manager() THEN
      NEW.rate_cents := huis.rate_for(NEW.firm_id, NEW.user_id, NEW.matter_id, NEW.work_date);
    END IF;
    RETURN NEW;
  END IF;
  -- Issuing, voiding and deleting a draft (huis_security) only attach and release items.
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF huis.invoice_locked(OLD.invoice_id) OR huis.invoice_locked(NEW.invoice_id) THEN
    RAISE EXCEPTION 'This time is on an issued invoice and can''t be changed.';
  END IF;
  IF NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Time stays on its Matter.';
  END IF;
  -- R25-6: only those who invoice the Matter put time on or take it off an invoice.
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    IF NOT huis.can_invoice_matter(NEW.matter_id) THEN RAISE EXCEPTION 'Only billing staff and the lead attorney change what''s on an invoice.'; END IF;
    IF NEW.invoice_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = NEW.invoice_id AND i.matter_id = NEW.matter_id AND i.status = 'draft') THEN
      RAISE EXCEPTION 'Time goes only on a draft invoice of its own Matter.';
    END IF;
  END IF;
  -- R25-2, R25-3: only billing staff change the rate or move time to someone else; the rate stays as it was otherwise.
  IF NOT huis.is_billing_manager() THEN
    IF NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'Only billing staff can move time to someone else.'; END IF;
    NEW.rate_cents := OLD.rate_cents;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION huis.expense_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF huis.invoice_locked(OLD.invoice_id) THEN RAISE EXCEPTION 'This expense is on an issued invoice and can''t be changed.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    IF NEW.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'New expenses start unbilled.'; END IF;
    RETURN NEW;
  END IF;
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF huis.invoice_locked(OLD.invoice_id) OR huis.invoice_locked(NEW.invoice_id) THEN
    RAISE EXCEPTION 'This expense is on an issued invoice and can''t be changed.';
  END IF;
  IF NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An expense stays on its Matter.';
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    IF NOT huis.can_invoice_matter(NEW.matter_id) THEN RAISE EXCEPTION 'Only billing staff and the lead attorney change what''s on an invoice.'; END IF;
    IF NEW.invoice_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM huis.invoices i WHERE i.id = NEW.invoice_id AND i.matter_id = NEW.matter_id AND i.status = 'draft') THEN
      RAISE EXCEPTION 'An expense goes only on a draft invoice of its own Matter.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- R25-1, R25-4: issuing locks its items, leaves out what isn't billable, and needs something to bill.
CREATE OR REPLACE FUNCTION huis.issue_invoice(p_invoice_id uuid, p_issued_on date, p_due_on date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE i huis.invoices; v_year int; v_seq int; v_number text; v_time bigint; v_exp bigint;
BEGIN
  SELECT * INTO i FROM huis.invoices WHERE id = p_invoice_id AND firm_id = huis.current_firm_id() FOR UPDATE;
  IF NOT FOUND OR NOT huis.can_invoice_matter(i.matter_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF i.status <> 'draft' THEN RAISE EXCEPTION 'This invoice has already been issued.'; END IF;
  IF p_issued_on IS NULL OR p_due_on IS NULL OR p_due_on < p_issued_on OR p_issued_on > current_date + 1 OR p_issued_on < current_date - 366 THEN
    RAISE EXCEPTION 'Check the invoice and due dates.';
  END IF;
  -- Hold the items: nothing joins, leaves or changes while they're copied.
  PERFORM 1 FROM huis.time_entries WHERE invoice_id = i.id FOR UPDATE;
  PERFORM 1 FROM huis.expenses WHERE invoice_id = i.id FOR UPDATE;
  -- What isn't billable goes back to unbilled rather than being locked to an invoice that doesn't bill it.
  UPDATE huis.time_entries SET invoice_id = NULL WHERE invoice_id = i.id AND NOT billable;
  UPDATE huis.expenses SET invoice_id = NULL WHERE invoice_id = i.id AND NOT billable;
  INSERT INTO huis.invoice_lines (firm_id, invoice_id, position, kind, line_date, who, description, tenths, rate_cents, amount_cents)
  SELECT i.firm_id, i.id, row_number() OVER (ORDER BY (k = 'expense'), d, created_at, id), k, d, who, description, tenths, rate, amount
    FROM (
      SELECT 'time' AS k, t.work_date AS d, u.full_name AS who, t.description, huis.billed_tenths(t.minutes) AS tenths,
             coalesce(t.rate_cents, 0) AS rate, huis.time_amount(t.minutes, t.rate_cents) AS amount, t.created_at, t.id
        FROM huis.time_entries t JOIN huis.users u ON u.id = t.user_id
       WHERE t.invoice_id = i.id
      UNION ALL
      SELECT 'expense', e.incurred_on, '', e.description, NULL, NULL, e.amount_cents, e.created_at, e.id
        FROM huis.expenses e WHERE e.invoice_id = i.id
    ) x;
  IF NOT EXISTS (SELECT 1 FROM huis.invoice_lines WHERE invoice_id = i.id) THEN
    RAISE EXCEPTION 'There''s nothing billable on this invoice.';
  END IF;
  SELECT coalesce(sum(amount_cents) FILTER (WHERE kind = 'time'), 0), coalesce(sum(amount_cents) FILTER (WHERE kind = 'expense'), 0)
    INTO v_time, v_exp FROM huis.invoice_lines WHERE invoice_id = i.id;
  v_year := extract(year FROM p_issued_on)::int;
  INSERT INTO huis.invoice_counters (firm_id, year, last) VALUES (i.firm_id, v_year, 1)
    ON CONFLICT (firm_id, year) DO UPDATE SET last = huis.invoice_counters.last + 1
    RETURNING last INTO v_seq;
  v_number := format('INV-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
  UPDATE huis.invoices SET status = 'issued', number = v_number, issued_on = p_issued_on, due_on = p_due_on,
         time_cents = v_time, expense_cents = v_exp, total_cents = v_time + v_exp, issued_by = huis.current_user_id()
   WHERE id = i.id;
  RETURN v_number;
END $$;

-- R25-5: other people's rates stay with billing staff and the Matter's invoicers. The app reads time without
-- the rate column; rates come from time_entry_rates(), which leaves out what the caller may not see.
REVOKE SELECT ON huis.time_entries FROM huis_app;
GRANT SELECT (id, firm_id, matter_id, user_id, work_date, minutes, description, billable, invoice_id, created_by, created_at)
  ON huis.time_entries TO huis_app;

CREATE FUNCTION huis.time_entry_rates(p_matter_id uuid) RETURNS TABLE (entry_id uuid, rate_cents int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT t.id, t.rate_cents FROM huis.time_entries t
   WHERE t.matter_id = p_matter_id AND t.firm_id = huis.current_firm_id() AND huis.dna_readable(p_matter_id)
     AND (t.user_id = huis.current_user_id() OR huis.is_billing_manager() OR huis.can_invoice_matter(p_matter_id))
$$;
ALTER FUNCTION huis.time_entry_rates(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.time_entry_rates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.time_entry_rates(uuid) TO huis_app;

-- Unbilled amount on a Matter, for anyone who can see it (a total, not anyone's rate).
CREATE FUNCTION huis.matter_unbilled_cents(p_matter_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE WHEN NOT huis.dna_readable(p_matter_id) THEN NULL ELSE
    coalesce((SELECT sum(huis.time_amount(t.minutes, t.rate_cents)) FROM huis.time_entries t
               WHERE t.matter_id = p_matter_id AND t.firm_id = huis.current_firm_id() AND t.invoice_id IS NULL AND t.billable), 0)
  + coalesce((SELECT sum(e.amount_cents) FROM huis.expenses e
               WHERE e.matter_id = p_matter_id AND e.firm_id = huis.current_firm_id() AND e.invoice_id IS NULL AND e.billable), 0) END
$$;
ALTER FUNCTION huis.matter_unbilled_cents(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.matter_unbilled_cents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.matter_unbilled_cents(uuid) TO huis_app;
GRANT SELECT ON huis.expenses TO huis_security;
