/**
 * Unit tests for wallet authentication (SEP-10 challenge + session tokens).
 */

import { beforeEach, describe, expect, test } from "vitest";
import { Keypair, Networks } from "stellar-sdk";

process.env.WALLET_AUTH_SECRET = "test-wallet-auth-secret";
process.env.WALLET_AUTH_HOME_DOMAIN = "localhost";
process.env.WALLET_AUTH_WEB_AUTH_DOMAIN = "stellar-batch-pay-test";
process.env.WALLET_AUTH_NETWORK_PASSPHRASE = Networks.TESTNET;

import {
  createWalletChallenge,
  createTestWalletSession,
  issueWalletSession,
  signChallengeForTests,
  validateWalletSessionToken,
  verifySignedChallenge,
} from "@/lib/wallet-auth";

describe("wallet-auth", () => {
  let clientKeypair: Keypair;

  beforeEach(() => {
    clientKeypair = Keypair.random();
  });

  test("createWalletChallenge returns signable SEP-10 challenge XDR", () => {
    const challenge = createWalletChallenge(clientKeypair.publicKey());
    expect(typeof challenge.challengeXdr).toBe("string");
    expect(challenge.challengeXdr.length).toBeGreaterThan(20);
    expect(challenge.networkPassphrase).toBe(Networks.TESTNET);
  });

  test("verifySignedChallenge accepts a valid wallet signature", () => {
    const challenge = createWalletChallenge(clientKeypair.publicKey());
    const signed = signChallengeForTests(
      challenge.challengeXdr,
      clientKeypair.secret(),
      challenge.networkPassphrase,
    );

    const result = verifySignedChallenge(signed, clientKeypair.publicKey());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.publicKey).toBe(clientKeypair.publicKey());
    }
  });

  test("verifySignedChallenge rejects a signature for a different publicKey", () => {
    const other = Keypair.random();
    const challenge = createWalletChallenge(clientKeypair.publicKey());
    const signed = signChallengeForTests(
      challenge.challengeXdr,
      clientKeypair.secret(),
      challenge.networkPassphrase,
    );

    const result = verifySignedChallenge(signed, other.publicKey());
    expect(result.valid).toBe(false);
  });

  test("verifySignedChallenge rejects replay of the same signed challenge", () => {
    const challenge = createWalletChallenge(clientKeypair.publicKey());
    const signed = signChallengeForTests(
      challenge.challengeXdr,
      clientKeypair.secret(),
      challenge.networkPassphrase,
    );

    expect(verifySignedChallenge(signed, clientKeypair.publicKey()).valid).toBe(true);
    expect(verifySignedChallenge(signed, clientKeypair.publicKey()).valid).toBe(false);
  });

  test("validateWalletSessionToken rejects missing token", () => {
    const result = validateWalletSessionToken(null, clientKeypair.publicKey());
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
  });

  test("validateWalletSessionToken accepts a freshly issued session", () => {
    const { sessionToken } = issueWalletSession(clientKeypair.publicKey());
    const result = validateWalletSessionToken(
      sessionToken,
      clientKeypair.publicKey(),
    );
    expect(result.valid).toBe(true);
    expect(result.publicKey).toBe(clientKeypair.publicKey());
  });

  test("validateWalletSessionToken rejects token bound to a different publicKey", () => {
    const other = Keypair.random();
    const sessionToken = createTestWalletSession(clientKeypair.publicKey());
    const result = validateWalletSessionToken(sessionToken, other.publicKey());
    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  test("createTestWalletSession helper issues verifiable tokens in tests", () => {
    const token = createTestWalletSession(clientKeypair.publicKey());
    expect(validateWalletSessionToken(token, clientKeypair.publicKey()).valid).toBe(true);
  });
});
