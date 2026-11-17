import { describeKeycloakError, isTransientUserError } from './supabase-user-error.util';

describe('describeKeycloakError', () => {
  it('shows the real status and body behind "Network response was not OK"', () => {
    const err = {
      message: 'Network response was not OK',
      response: { status: 409 },
      responseData: { errorMessage: 'User exists with same username' },
    };
    expect(describeKeycloakError(err)).toBe('HTTP 409 — User exists with same username');
  });

  it('reads the other body shapes Keycloak uses', () => {
    expect(describeKeycloakError({ response: { status: 400 }, responseData: { error: 'invalid_request' } })).toBe(
      'HTTP 400 — invalid_request',
    );
    expect(describeKeycloakError({ response: { status: 500 }, responseData: 'value too long for type character varying(255)' })).toBe(
      'HTTP 500 — value too long for type character varying(255)',
    );
  });

  it('falls back to the JSON of an unknown body, trimmed', () => {
    const out = describeKeycloakError({ response: { status: 400 }, responseData: { field: 'x'.repeat(400) } });
    expect(out.startsWith('HTTP 400 — {"field":"xxx')).toBe(true);
    expect(out.length).toBeLessThan(260);
  });

  it('gives the status alone when there is no body, and not the useless generic text', () => {
    expect(describeKeycloakError({ message: 'Network response was not OK', response: { status: 403 } })).toBe('HTTP 403');
  });

  it('uses the message when there was no HTTP answer at all', () => {
    expect(describeKeycloakError({ message: 'connect ECONNREFUSED 10.0.0.2:8080' })).toBe('connect ECONNREFUSED 10.0.0.2:8080');
    expect(describeKeycloakError(null)).toBe('unknown error');
  });
});

describe('isTransientUserError', () => {
  it.each([408, 429, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(isTransientUserError({ response: { status } })).toBe(true);
  });

  it('does not retry an answer that will not change', () => {
    for (const status of [400, 401, 403, 404, 409, 500]) {
      expect(isTransientUserError({ response: { status } })).toBe(false);
    }
  });

  it('retries a dropped connection', () => {
    expect(isTransientUserError({ message: 'read ECONNRESET' })).toBe(true);
    expect(isTransientUserError({ message: 'fetch failed' })).toBe(true);
    expect(isTransientUserError({ message: 'Invalid value' })).toBe(false);
  });
});
