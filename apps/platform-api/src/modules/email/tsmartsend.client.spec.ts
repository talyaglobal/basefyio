import { sendViaTsmartsend, TsmartsendError } from './tsmartsend.client';

describe('sendViaTsmartsend', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  const mail = { apiKey: 'ts_abc', from: 'App <no-reply@app.example>', to: 'u@x.test', subject: 'Hi', html: '<p>x</p>' };

  it('posts a Resend-shaped body with the bearer key and an idempotency key', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm1' }) });
    global.fetch = fetchMock as never;
    await expect(sendViaTsmartsend({ ...mail, replyTo: 'r@x.test', idempotencyKey: 'k1' })).resolves.toEqual({ id: 'm1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://send.tsmart.ai/emails');
    expect(init.headers.authorization).toBe('Bearer ts_abc');
    expect(init.headers['idempotency-key']).toBe('k1');
    expect(JSON.parse(init.body)).toEqual({
      from: mail.from, to: ['u@x.test'], subject: 'Hi', html: '<p>x</p>', reply_to: 'r@x.test',
    });
  });

  it('honours TSMART_SEND_BASE_URL and trims the trailing slash', async () => {
    process.env.TSMART_SEND_BASE_URL = 'https://mail.internal/';
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as never;
    await sendViaTsmartsend(mail);
    expect(fetchMock.mock.calls[0][0]).toBe('https://mail.internal/emails');
  });

  it('maps 401 to a non-retryable error and 429/5xx to retryable ones', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ name: 'invalid_api_key', message: 'bad key' }),
    }) as never;
    await expect(sendViaTsmartsend(mail)).rejects.toMatchObject({ status: 401, retryable: false });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'x', json: async () => null }) as never;
    await expect(sendViaTsmartsend(mail)).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('reports an unreachable service as a retryable TsmartsendError', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    await expect(sendViaTsmartsend(mail)).rejects.toBeInstanceOf(TsmartsendError);
  });
});
