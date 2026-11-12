import { parseScopeJudgement, quickScope } from './ai-scope';

describe('quickScope', () => {
  const ctx = { tableNames: ['qa_e2e_ai_posts', 'qa_e2e_ai_comments'], projectNames: ['QA E2E Test!'] };

  it.each([
    'Bu projede hangi tablolar var?',
    'qa_e2e_ai_posts tablosuna 2 post ekle ve JOIN + COUNT ile göster',
    'Show me the posts',
    'In qa_e2e_ai_posts, set the column title to NOT NULL',
    'Which tables exist in this project?',
    'RLS: herkes okusun, sadece sahibi yazsın',
    'İndeks önerir misin?',
    'Wie richte ich die Authentifizierung ein?',
    '¿Cómo creo una tabla?',
    'select count(*) from orders',
    'What can basefyio do?',
    'open QA E2E Test! please',
  ])('lets "%s" through', (msg) => {
    expect(quickScope(msg, ctx)).toBe('in');
  });

  it('lets follow-ups through when the conversation has history', () => {
    expect(quickScope('evet, devam et', { hasHistory: true })).toBe('in');
  });

  it('is only unsure — never a refusal — for messages with no product words', () => {
    expect(quickScope('Write me a poem about the sea', ctx)).toBe('unsure');
    expect(quickScope('', ctx)).toBe('unsure');
  });
});

describe('parseScopeJudgement', () => {
  it('reads IN as in scope', () => {
    expect(parseScopeJudgement('IN')).toEqual({ inScope: true, refusal: null });
    expect(parseScopeJudgement(' "IN". ')).toEqual({ inScope: true, refusal: null });
  });

  it('treats an empty or unclear answer as in scope', () => {
    expect(parseScopeJudgement('')).toEqual({ inScope: true, refusal: null });
    expect(parseScopeJudgement('ok')).toEqual({ inScope: true, refusal: null });
  });

  it('returns the refusal sentence in the user language', () => {
    const r = parseScopeJudgement('Üzgünüm, yalnızca basefyio ve projelerinizle ilgili konularda yardımcı olabilirim.');
    expect(r.inScope).toBe(false);
    expect(r.refusal).toMatch(/basefyio/);
  });
});
