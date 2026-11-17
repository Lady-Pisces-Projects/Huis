import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyGoogleSignIn } from "../src/auth/google";

/**
 * Security review 29: "Sign in with Google" (branch google-signin).
 * Each test fails today and passes once its finding is fixed.
 */

const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const OTHER_CLIENT = "999999999-other.apps.googleusercontent.com";
const SUB = "109876543210987654321";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "g-key", alg: "RS256" }] });
});

function base(over: Record<string, unknown> = {}) {
  return new SignJWT({ sub: SUB, nonce: "n-1", name: "Maria Lopez", email: "maria@lopezlaw.example", email_verified: true, ...over })
    .setProtectedHeader({ alg: "RS256", kid: "g-key" })
    .setIssuer("https://accounts.google.com")
    .setIssuedAt();
}

describe("R29: Google ID token checks", () => {
  it("R29-1: a token issued to another client (azp) is refused, even when Huis is one of several audiences", async () => {
    // OIDC Core 3.1.3.7 (4)(5): with several audiences azp must be present, and azp must be our client id.
    const multi = await base({ azp: OTHER_CLIENT }).setAudience([CLIENT_ID, OTHER_CLIENT]).setExpirationTime("1h").sign(privateKey);
    await expect(verifyGoogleSignIn(multi, { clientId: CLIENT_ID, nonce: "n-1", keys })).rejects.toThrow();
    const multiNoAzp = await base().setAudience([CLIENT_ID, OTHER_CLIENT]).setExpirationTime("1h").sign(privateKey);
    await expect(verifyGoogleSignIn(multiNoAzp, { clientId: CLIENT_ID, nonce: "n-1", keys })).rejects.toThrow();
    const wrongAzp = await base({ azp: OTHER_CLIENT }).setAudience(CLIENT_ID).setExpirationTime("1h").sign(privateKey);
    await expect(verifyGoogleSignIn(wrongAzp, { clientId: CLIENT_ID, nonce: "n-1", keys })).rejects.toThrow();
  });

  it("R29-2: a token with no expiry is refused (jose only checks exp when it is present)", async () => {
    const noExp = await base().setAudience(CLIENT_ID).sign(privateKey);
    await expect(verifyGoogleSignIn(noExp, { clientId: CLIENT_ID, nonce: "n-1", keys })).rejects.toThrow();
  });
});
