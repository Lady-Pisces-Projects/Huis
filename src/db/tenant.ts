import { isIP } from "node:net";
import pg from "pg";
import { PermissionDeniedError, SignInRuleError, UnauthenticatedError, UserFacingError } from "../errors";
import type { Role } from "../security/permissions";

/** Who is making this request, as established by the sign-in layer. */
export interface RequestContext {
  firmId: string;
  userId: string;
  ipAddress?: string;
  userAgent?: string;
  /** From the session cookie; must match the user's current session version. */
  sessionVersion?: number;
  /** Only for signing out: ending your own sessions works even when the firm's sign-in rule refuses this account. */
  skipSignInRule?: boolean;
}

/** The verified, active user behind a request (loaded from the database). */
export interface Actor {
  userId: string;
  firmId: string;
  role: Role;
  fullName: string;
  sessionVersion: number;
}

/** A database session bound to one firm and one user. */
export interface FirmSession {
  readonly client: pg.PoolClient;
  readonly ctx: RequestContext;
  readonly actor: Actor;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only way application code reaches tenant data.
 *
 * Every call runs in a transaction that sets the firm and user for Postgres
 * row-level security. Settings are transaction-local, so a pooled connection
 * can never carry one firm's context into another firm's request.
 */
export class HuisDb {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(connectionString: string): HuisDb {
    return new HuisDb(new pg.Pool({ connectionString, max: 10 }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withFirm<T>(ctx: RequestContext, fn: (s: FirmSession) => Promise<T>): Promise<T> {
    if (!UUID.test(ctx.firmId) || !UUID.test(ctx.userId)) throw new UnauthenticatedError();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ip = ctx.ipAddress && isIP(ctx.ipAddress) ? ctx.ipAddress : "";
      await client.query(
        "SELECT set_config('app.firm_id', $1, true), set_config('app.user_id', $2, true), set_config('app.ip', $3, true)",
        [ctx.firmId, ctx.userId, ip],
      );
      const { rows } = await client.query<{ id: string; firm_id: string; role: Role; full_name: string; status: string; session_version: number }>(
        "SELECT id, firm_id, role, full_name, status, session_version FROM huis.users WHERE id = $1",
        [ctx.userId],
      );
      const row = rows[0];
      if (!row || row.status !== "active" || row.firm_id !== ctx.firmId) throw new UnauthenticatedError();
      // The firm's sign-in rule, on every request: turning it on ends other sign-ins at once. Checked before the
      // session version (which turning the rule on also moves) so the person is told why.
      if (!ctx.skipSignInRule) {
        const rule = await client.query<{ ok: boolean }>("SELECT huis.session_signin_allowed() AS ok");
        if (rule.rows[0]?.ok !== true) throw new SignInRuleError();
      }
      if (ctx.sessionVersion !== undefined && ctx.sessionVersion !== row.session_version) throw new UnauthenticatedError();
      const actor: Actor = {
        userId: row.id, firmId: row.firm_id, role: row.role, fullName: row.full_name, sessionVersion: row.session_version,
      };
      const result = await fn({ client, ctx, actor });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw translatePgError(err);
    } finally {
      client.release();
    }
  }

  /**
   * For the two operations that happen before a firm context exists:
   * firm sign-up and sign-in lookup. Only database functions designed for
   * this (huis.bootstrap_firm, huis.resolve_identity) can return anything here;
   * every table query returns zero rows without a firm context.
   */
  async withoutFirm<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw translatePgError(err);
    } finally {
      client.release();
    }
  }
}

/** Row-level-security rejections become permission errors, not raw SQL errors. */
export function translatePgError(err: unknown): unknown {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "42501") {
    return new PermissionDeniedError("perform this action");
  }
  // The firm's sign-in rule (HU403): the database wrote these messages for the person using Huis.
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "HU403" && err instanceof Error) {
    return new UserFacingError(err.message.slice(0, 300), 403);
  }
  // Subscription limits (Phase 10): the database wrote these messages for the person using Huis.
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "HU402" && err instanceof Error) {
    return new UserFacingError(err.message.slice(0, 300), 402);
  }
  return err;
}
