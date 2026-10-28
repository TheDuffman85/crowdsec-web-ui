import { describe, expect, test, vi } from 'vitest';
import { CrowdsecDatabase } from '../../database';
import { createTestDatabase, createTestDatabasePath } from './harness';

const ISSUER = 'https://idp.example.com';

function logoutParams() {
  const now = Math.floor(Date.now() / 1000);
  return {
    issuer: ISSUER,
    subject: 'subject-1',
    tokenId: 'logout-event-1',
    tokenExpiresAt: now + 301,
    sessionExpiresAt: now + 3600,
  };
}

describe('OIDC logout persistence', () => {
  test('remembers processed events after reopening and scopes token IDs to the issuer', () => {
    const cachePath = createTestDatabasePath();
    const db = new CrowdsecDatabase({ cachePath });
    const firstUser = db.upsertOidcUser({ username: 'first', role: 'admin', issuer: ISSUER, subject: 'subject-1' });
    const secondIssuer = 'https://other-idp.example.com';
    const secondUser = db.upsertOidcUser({ username: 'second', role: 'admin', issuer: secondIssuer, subject: 'subject-1' });
    const params = logoutParams();
    try {
      db.applyOidcLogout(params);
      expect(db.getAuthUserById(firstUser.id)!.session_version).toBe(firstUser.session_version + 1);
    } finally {
      db.close();
    }

    const reopened = new CrowdsecDatabase({ cachePath });
    try {
      reopened.applyOidcLogout(params);
      expect(reopened.getAuthUserById(firstUser.id)!.session_version).toBe(firstUser.session_version + 1);
      reopened.applyOidcLogout({ ...params, issuer: secondIssuer });
      expect(reopened.getAuthUserById(secondUser.id)!.session_version).toBe(secondUser.session_version + 1);
    } finally {
      reopened.close();
    }
  });

  test('a logout with sid and sub advances the logout version of known identities only', () => {
    const db = createTestDatabase();
    db.upsertOidcUser({ username: 'operator', role: 'admin', issuer: ISSUER, subject: 'subject-1' });
    try {
      expect(db.getOidcLogoutVersion(ISSUER, 'subject-1')).toBe(1);
      db.applyOidcLogout({ ...logoutParams(), sessionId: 'session-1' });
      expect(db.getOidcLogoutVersion(ISSUER, 'subject-1')).toBe(2);
      db.applyOidcLogout({ ...logoutParams(), tokenId: 'logout-event-2', sessionId: 'session-2' });
      expect(db.getOidcLogoutVersion(ISSUER, 'subject-1')).toBe(3);

      db.applyOidcLogout({ ...logoutParams(), tokenId: 'logout-event-3', subject: 'unknown', sessionId: 'session-3' });
      expect(db.getOidcLogoutVersion(ISSUER, 'unknown')).toBe(1);
      expect(db.db.prepare('SELECT COUNT(*) AS count FROM oidc_logout_versions').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test.each([undefined, 'session-1'])('rolls back the event and revocation together on failure (sid=%s)', (sessionId) => {
    const db = createTestDatabase();
    const user = db.upsertOidcUser({ username: 'operator', role: 'admin', issuer: ISSUER, subject: 'subject-1' });
    const params = { ...logoutParams(), sessionId };
    const revokeUser = db.revokeOidcUserSessions.bind(db);
    const revokeSession = db.revokeOidcSession.bind(db);
    // Fail after the revocation write to ensure both writes are rolled back.
    const failure = sessionId
      ? vi.spyOn(db, 'revokeOidcSession').mockImplementation((...args) => {
        revokeSession(...args);
        throw new Error('write failed');
      })
      : vi.spyOn(db, 'revokeOidcUserSessions').mockImplementation((...args) => {
        revokeUser(...args);
        throw new Error('write failed');
      });
    try {
      expect(() => db.applyOidcLogout(params)).toThrow('write failed');
      expect(db.getAuthUserById(user.id)!.session_version).toBe(user.session_version);
      expect(db.isOidcSessionRevoked(ISSUER, 'session-1')).toBe(false);
      expect(db.getOidcLogoutVersion(ISSUER, 'subject-1')).toBe(1);

      failure.mockRestore();
      db.applyOidcLogout(params);
      if (sessionId) {
        expect(db.isOidcSessionRevoked(ISSUER, sessionId)).toBe(true);
        expect(db.getAuthUserById(user.id)!.session_version).toBe(user.session_version);
      } else {
        expect(db.getAuthUserById(user.id)!.session_version).toBe(user.session_version + 1);
      }
    } finally {
      failure.mockRestore();
      db.close();
    }
  });
});
