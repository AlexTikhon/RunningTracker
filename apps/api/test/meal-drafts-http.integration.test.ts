import { apiErrorResponseSchema, mealDraftProposalResponseSchema, mealViewSchema } from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool, type DatabasePool } from '../src/database/database.js';
import type { LlmCallOptions, LlmJsonSchema, LlmProvider, LlmStructuredInput, LlmStructuredResult } from '../src/insights/llm-provider.js';
import { fakeMealDraftAnswer } from '../src/meals/drafts/fake-meal-draft-provider.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0092 over HTTP with the real runtime role, session, Origin and CSRF checks. The provider is a test double that
// records what it was sent and settles when the test says so; no test can reach a model.
const allowedOrigin = 'http://127.0.0.1:5173';
const nobody = '99999999-9999-4999-8999-999999999999';
const TODAY = '2026-11-14';
// A recognisable private string: it must never appear in a log line, a statement or anything stored.
const TEXT = 'Dinner: SENTINELQX stew, total 650 kcal, protein 40 g';

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(`${TODAY}T12:00:00.000Z`),
};

type Behaviour = (input: LlmStructuredInput, options: LlmCallOptions) => Promise<LlmStructuredResult>;
const answerFor: Behaviour = (input) => Promise.resolve({ value: fakeMealDraftAnswer(input.user) });

class TestProvider implements LlmProvider {
  public readonly model = 'test-model';
  public behaviour: Behaviour = answerFor;
  public inputs: LlmStructuredInput[] = [];
  public schemas: LlmJsonSchema[] = [];

  public generateStructured(input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    this.inputs.push(input);
    this.schemas.push(schema);
    return this.behaviour(input, options);
  }
}

interface Credentials {
  cookie: string;
  csrf: string;
}

async function login(app: ReturnType<typeof createApp>, userId: string): Promise<Credentials> {
  const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
  const setCookie = (response.headers['set-cookie'] as unknown as string[])[0]!;
  return { cookie: setCookie.split(';', 1)[0]!, csrf: (response.body as { csrf: { token: string } }).csrf.token };
}

function configuration(overrides: Record<string, string>): Environment {
  const integration = loadIntegrationTestConfiguration();
  return validateEnvironment({
    ALLOWED_ORIGINS: allowedOrigin,
    APP_ENV: 'test',
    DATABASE_URL: integration.runtime.connectionString,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: [ids.userDual, ids.userInactive, ids.userOrgA, ids.userOrgB, nobody].join(','),
    MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
    SESSION_COOKIE_SECURE: 'false',
    ...overrides,
  });
}

const codeOf = (response: request.Response): string => {
  expect(response.headers['cache-control']).toBe('no-store');
  return apiErrorResponseSchema.parse(response.body).error.code;
};

describe('ADR-0092 meal draft proposals: off by default', () => {
  it('answers 503 MEAL_DRAFT_DISABLED after the session and CSRF checks, and contacts nothing', async () => {
    const config = configuration({});
    expect(config.MEAL_DRAFTS).toBeUndefined();
    const pool = createDatabasePool({ ...config, DB_POOL_MAX: 1 });
    try {
      const app = createApp({
        clock,
        config,
        pool,
        sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS }),
      });
      const who = await login(app, ids.userDual);
      const response = await request(app)
        .post(`/api/orgs/${ids.orgA}/meals/draft-proposals`)
        .set('Cookie', who.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, who.csrf)
        .type('application/json')
        .send({ localDate: TODAY, text: TEXT, timeZone: 'Europe/Warsaw', version: 'meal-draft-1' })
        .expect(503);
      expect(codeOf(response)).toBe('MEAL_DRAFT_DISABLED');
    } finally {
      await pool.end();
    }
  });
});

describe('ADR-0092 meal draft proposals under the runtime role', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const provider = new TestProvider();
  const statements: string[] = [];
  const logLines: string[] = [];
  const credentials = new Map<string, Credentials>();
  const patched = Symbol('statementsRecorded');

  // The real runtime pool with every statement recorded, so "nothing reads or writes meals" is a fact.
  const recordingPool: DatabasePool = {
    connect: async () => {
      const client = (await runtimePool.connect()) as PoolClient & { [patched]?: true };
      if (client[patched] !== true) {
        const query = client.query.bind(client) as (...args: unknown[]) => unknown;
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          const first = args[0];
          statements.push(typeof first === 'string' ? first : (first as { text: string }).text);
          return query(...args);
        };
        client[patched] = true;
      }
      return client;
    },
  };

  beforeAll(() => {
    const config = configuration({
      MEAL_DRAFTS_ALLOWANCE: '1000',
      MEAL_DRAFTS_MAX_CONCURRENT: '1',
      MEAL_DRAFTS_PROVIDER: 'fake',
      MEAL_DRAFTS_TIMEOUT_MS: '1000',
      MEAL_DRAFTS_USER_RATE_PER_MINUTE: '60',
    });
    // One connection only: a request that kept it while the model worked would block everything else.
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 1 });
    ownerPool = new Pool({
      application_name: 'running-tracker-meal-draft-fixtures',
      connectionString: loadIntegrationTestConfiguration().migration.connectionString,
      max: 2,
    });
    app = createApp({
      clock,
      config,
      logger: createLogger({ clock, write: (_level, line) => logLines.push(line) }),
      pool: recordingPool,
      sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES), ttlMs: config.SESSION_TTL_MS }),
      testOnlyMealDraftProvider: provider,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    await ownerPool.query('DELETE FROM meals');
    provider.behaviour = answerFor;
    provider.inputs = [];
    provider.schemas = [];
    statements.length = 0;
    logLines.length = 0;
    for (const userId of [ids.userDual, ids.userInactive, ids.userOrgA, ids.userOrgB, nobody]) credentials.set(userId, await login(app, userId));
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM meals').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function propose(userId: string, orgId: string, body: Record<string, unknown> = {}) {
    const who = credentials.get(userId)!;
    return request(app)
      .post(`/api/orgs/${orgId}/meals/draft-proposals`)
      .set('Cookie', who.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, who.csrf)
      .type('application/json')
      .send({ localDate: '2026-11-13', text: TEXT, timeZone: 'europe/warsaw', version: 'meal-draft-1', ...body });
  }

  const mealCount = async () => Number((await ownerPool.query<{ count: string }>('SELECT count(*) FROM meals')).rows[0]!.count);

  it('answers a grounded draft for the form\'s date and canonical zone, sends only the text, and stores nothing', async () => {
    const response = await propose(ids.userDual, ids.orgA).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mealDraftProposalResponseSchema.parse(response.body)).toEqual({
      localDate: '2026-11-13',
      mealType: { excerpt: 'Dinner', status: 'proposed', value: 'dinner' },
      nutrition: {
        carbohydrateG: { status: 'not_stated' },
        energyKcal: { excerpt: '650 kcal', status: 'proposed', value: 650 },
        fatG: { status: 'not_stated' },
        proteinG: { excerpt: 'protein 40 g', status: 'proposed', value: 40 },
      },
      outcome: 'draft',
      timeZone: 'Europe/Warsaw',
      title: 'SENTINELQX stew',
      version: 'meal-draft-1',
    });
    // The model saw the text and the fixed instructions: no date, zone, organization or person.
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]!.user).toBe(TEXT);
    const sent = JSON.stringify(provider.inputs[0]);
    for (const secret of ['2026-11-13', 'Warsaw', ids.orgA, ids.userDual]) expect(sent).not.toContain(secret);

    expect(await mealCount()).toBe(0);
    const touched = statements.join('\n').toLowerCase();
    expect(touched).not.toMatch(/\bmeals\b/u);
    expect(touched).not.toContain('sentinel');
    expect(logLines.join('\n')).not.toContain('SENTINEL');
    expect(logLines.join('\n')).toContain('"outcome":"draft"');
  });

  it.each([
    ['a person with no membership at all', nobody, ids.orgA],
    ['a member of another organization', ids.userOrgB, ids.orgA],
    ['a person whose membership is inactive', ids.userInactive, ids.orgA],
  ])('refuses %s before any model call', async (_name, userId, orgId) => {
    const response = await propose(userId, orgId).expect(403);
    expect(codeOf(response)).toBe('ORG_ACCESS_DENIED');
    expect(provider.inputs).toHaveLength(0);
  });

  it('applies the meal log\'s date rules before any model call, and refuses malformed requests', async () => {
    expect(codeOf(await propose(ids.userDual, ids.orgA, { localDate: '2026-11-15' }).expect(400))).toBe('INVALID_REQUEST');
    // Already the 15th in Kiritimati (UTC+14) at 12:00 UTC on the 14th: allowed there.
    await propose(ids.userDual, ids.orgA, { localDate: '2026-11-15', timeZone: 'Pacific/Kiritimati' }).expect(200);
    expect(codeOf(await propose(ids.userDual, ids.orgA, { localDate: '1999-12-31' }).expect(400))).toBe('INVALID_REQUEST');
    expect(codeOf(await propose(ids.userDual, ids.orgA, { text: 'x'.repeat(501) }).expect(400))).toBe('INVALID_REQUEST');
    expect(codeOf(await propose(ids.userDual, ids.orgA, { text: 'Soup\u0007' }).expect(400))).toBe('INVALID_REQUEST');
    expect(codeOf(await propose(ids.userDual, ids.orgA, { version: 'meal-draft-0' }).expect(400))).toBe('INVALID_REQUEST');
    expect(codeOf(await propose(ids.userDual, ids.orgA, { userId: ids.userOrgA }).expect(400))).toBe('INVALID_REQUEST');
    expect(provider.inputs).toHaveLength(1);
  });

  it('requires a session and the CSRF token', async () => {
    const anonymous = await request(app)
      .post(`/api/orgs/${ids.orgA}/meals/draft-proposals`)
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ localDate: TODAY, text: TEXT, timeZone: 'Europe/Warsaw', version: 'meal-draft-1' });
    expect(anonymous.status).toBe(401);
    const who = credentials.get(ids.userDual)!;
    const noCsrf = await request(app)
      .post(`/api/orgs/${ids.orgA}/meals/draft-proposals`)
      .set('Cookie', who.cookie)
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ localDate: TODAY, text: TEXT, timeZone: 'Europe/Warsaw', version: 'meal-draft-1' });
    expect(noCsrf.status).toBe(403);
    expect(provider.inputs).toHaveLength(0);
  });

  it('holds no database connection while the model works (a one-connection pool stays usable)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider.behaviour = async (input, options) => {
      started();
      await gate;
      return answerFor(input, options);
    };
    const pending = propose(ids.userDual, ids.orgA).then((response) => response);
    await providerStarted;
    const during = await request(app)
      .get(`/api/orgs/${ids.orgA}/meals?localDate=2026-11-13`)
      .set('Cookie', credentials.get(ids.userOrgA)!.cookie)
      .timeout(3_000);
    expect(during.status).toBe(200);
    release();
    expect((await pending).status).toBe(200);
  });

  it('does not deliver the proposal when the membership is revoked while the model works', async () => {
    provider.behaviour = async (input, options) => {
      await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userDual]);
      return answerFor(input, options);
    };
    const response = await propose(ids.userDual, ids.orgA).expect(403);
    expect(codeOf(response)).toBe('ORG_ACCESS_DENIED');
    expect(JSON.stringify(response.body)).not.toContain('SENTINELQX');
    expect(logLines.join('\n')).toContain('"outcome":"access_lost"');
  });

  it('does not deliver the proposal when the session is signed out while the model works', async () => {
    const who = credentials.get(ids.userDual)!;
    provider.behaviour = async (input, options) => {
      await request(app).delete('/api/session').set('Cookie', who.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, who.csrf).expect(204);
      return answerFor(input, options);
    };
    const response = await propose(ids.userDual, ids.orgA).expect(401);
    expect(JSON.stringify(response.body)).not.toContain('SENTINELQX');
  });

  it('fails an ungrounded or fabricated answer without returning any of it', async () => {
    const ungrounded = await propose(ids.userDual, ids.orgA, { text: 'Two eggs and toast [ungrounded]' }).expect(502);
    expect(codeOf(ungrounded)).toBe('MEAL_DRAFT_FAILED');
    expect(apiErrorResponseSchema.parse(ungrounded.body).error.details).toEqual({ reason: 'ungrounded_output' });
    const fabricated = mealDraftProposalResponseSchema.parse((await propose(ids.userDual, ids.orgA, { text: 'Lunch: salad [fabricate]' }).expect(200)).body);
    expect(fabricated).toMatchObject({ nutrition: { energyKcal: { reason: 'unverified', status: 'withheld' } }, outcome: 'draft' });
  });

  // Grounding corrections (2026-11-14): the injected provider answers schema-valid but UNSAFE claims for the three
  // confirmed defects; the public answer withholds each of them and still carries the legitimate values.
  describe('unsafe schema-valid claims are withheld (grounding corrections)', () => {
    const none = { abstain: 'not_stated', evidence: null, value: null } as const;
    const answer = (title: string, fields: Partial<Record<'carbohydrateG' | 'energyKcal' | 'fatG' | 'proteinG', { abstain: null; evidence: string; value: string }>>) => ({
      carbohydrateG: fields.carbohydrateG ?? none,
      energyKcal: fields.energyKcal ?? none,
      fatG: fields.fatG ?? none,
      mealType: null,
      mealTypeEvidence: null,
      outcome: 'draft',
      proteinG: fields.proteinG ?? none,
      title,
    });
    const claim = (value: string, evidence: string) => ({ abstain: null, evidence, value });
    const draftFor = async (text: string, value: unknown) => {
      provider.behaviour = () => Promise.resolve({ value });
      const response = await propose(ids.userDual, ids.orgA, { text }).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const parsed = mealDraftProposalResponseSchema.parse(response.body);
      if (parsed.outcome !== 'draft') throw new Error('expected a draft');
      return parsed.nutrition;
    };

    it('withholds per-100 g values whose qualifier is in another clause, and keeps a separately stated total', async () => {
      expect(
        await draftFor(
          'Yogurt. Nutrition per 100 g, 60 kcal, protein 4 g. I ate 200 g.',
          answer('Yogurt', { energyKcal: claim('60', '60 kcal'), proteinG: claim('4', 'protein 4 g') }),
        ),
      ).toEqual({
        carbohydrateG: { status: 'not_stated' },
        energyKcal: { reason: 'per_portion', status: 'withheld' },
        fatG: { status: 'not_stated' },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      });
      expect(
        await draftFor(
          'Yogurt bowl. На 100 г: 60 ккал, белки 4 г. Итого 180 ккал, белки 12 г, жиры 0 г, углеводы 15,5 г.',
          answer('Yogurt bowl', {
            carbohydrateG: claim('15,5', 'углеводы 15,5 г'),
            energyKcal: claim('180', '180 ккал'),
            fatG: claim('0', 'жиры 0 г'),
            proteinG: claim('4', 'белки 4 г'),
          }),
        ),
      ).toEqual({
        carbohydrateG: { excerpt: 'углеводы 15,5 г', status: 'proposed', value: 15.5 },
        energyKcal: { excerpt: '180 ккал', status: 'proposed', value: 180 },
        fatG: { excerpt: 'жиры 0 г', status: 'proposed', value: 0 },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      });
    });

    it('withholds magnitudes behind a spaced or Unicode minus sign', async () => {
      expect(await draftFor('Soup, - 500 kcal, − 5 g of protein', answer('Soup', { energyKcal: claim('500', '500 kcal'), proteinG: claim('5', '5 g of protein') }))).toMatchObject({
        energyKcal: { reason: 'ambiguous', status: 'withheld' },
        proteinG: { reason: 'ambiguous', status: 'withheld' },
      });
    });

    // Second correction (2026-11-14): a nutrition label's "total" and a range split by a line break.
    it('withholds a label\'s "total" lines and keeps the totals the person states as eaten', async () => {
      expect(
        await draftFor(
          'Yogurt. Nutrition facts per 100 g: 60 kcal. Total protein 4 g. Fat 4 g total. Total: carbs 9 g.',
          answer('Yogurt', {
            carbohydrateG: claim('9', 'carbs 9 g'),
            energyKcal: claim('60', '60 kcal'),
            fatG: claim('4', 'Fat 4 g'),
            proteinG: claim('4', 'protein 4 g'),
          }),
        ),
      ).toEqual({
        carbohydrateG: { reason: 'per_portion', status: 'withheld' },
        energyKcal: { reason: 'per_portion', status: 'withheld' },
        fatG: { reason: 'per_portion', status: 'withheld' },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      });
      expect(
        await draftFor(
          'Yogurt 200 g. Per 100 g: 60 kcal, protein 4 g. In total I ate 120 kcal, protein 8 g.\nВсего: жиры 3 г.',
          answer('Yogurt', { energyKcal: claim('120', '120 kcal'), fatG: claim('3', 'жиры 3 г'), proteinG: claim('4', 'protein 4 g') }),
        ),
      ).toEqual({
        carbohydrateG: { status: 'not_stated' },
        energyKcal: { excerpt: '120 kcal', status: 'proposed', value: 120 },
        fatG: { reason: 'per_portion', status: 'withheld' },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      });
    });

    it('withholds ranges whose separator or other endpoint is on another line, and keeps values on their own lines', async () => {
      expect(
        await draftFor(
          'Soup, 500 -\n600 kcal, 5 to\n6 g protein\nfat 0 g\ncarbs 12,50 g',
          answer('Soup', {
            carbohydrateG: claim('12,5', 'carbs 12,50 g'),
            energyKcal: claim('600', '600 kcal'),
            fatG: claim('0', 'fat 0 g'),
            proteinG: claim('6', '6 g protein'),
          }),
        ),
      ).toEqual({
        carbohydrateG: { excerpt: 'carbs 12,50 g', status: 'proposed', value: 12.5 },
        energyKcal: { reason: 'ambiguous', status: 'withheld' },
        fatG: { excerpt: 'fat 0 g', status: 'proposed', value: 0 },
        proteinG: { reason: 'ambiguous', status: 'withheld' },
      });
      expect(
        await draftFor('Суп, от 500 до\n600 ккал', answer('Суп', { energyKcal: claim('600', '600 ккал') })),
      ).toMatchObject({ energyKcal: { reason: 'ambiguous', status: 'withheld' } });
    });

    it('withholds forbidden precision and rounded claims, and accepts trailing zeros', async () => {
      expect(
        await draftFor(
          'Soup, protein 12.5000000000000001 g, fat 3.50 g, 20000.05 kcal',
          answer('Soup', { energyKcal: claim('20000.05', '20000.05 kcal'), fatG: claim('3.5', 'fat 3.50 g'), proteinG: claim('12.5', 'protein 12.5000000000000001 g') }),
        ),
      ).toEqual({
        carbohydrateG: { status: 'not_stated' },
        energyKcal: { reason: 'outside_contract', status: 'withheld' },
        fatG: { excerpt: 'fat 3.50 g', status: 'proposed', value: 3.5 },
        proteinG: { reason: 'unverified', status: 'withheld' },
      });
    });
  });

  it('saves a confirmed draft only through the existing create route, as a manual entry', async () => {
    const proposal = mealDraftProposalResponseSchema.parse((await propose(ids.userDual, ids.orgA).expect(200)).body);
    if (proposal.outcome !== 'draft' || proposal.nutrition.energyKcal.status !== 'proposed') throw new Error('expected a draft');
    expect(await mealCount()).toBe(0);
    const who = credentials.get(ids.userDual)!;
    const created = await request(app)
      .post(`/api/orgs/${ids.orgA}/meals`)
      .set('Cookie', who.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, who.csrf)
      .type('application/json')
      .send({
        energyKcal: proposal.nutrition.energyKcal.value,
        fatG: 12,
        idempotencyKey: '0e000000-0000-4000-8000-00000000000e',
        localDate: proposal.localDate,
        mealType: 'dinner',
        timeZone: proposal.timeZone,
        title: proposal.title,
      })
      .expect(201);
    expect(mealViewSchema.parse(created.body)).toMatchObject({ energyKcal: 650, fatG: 12, proteinG: null, source: 'manual', title: 'SENTINELQX stew' });
    expect(await mealCount()).toBe(1);
  });
});

describe('ADR-0092 meal draft proposals: the model call outlives its request', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const credentials = new Map<string, Credentials>();
  const held: Array<{ aborted: boolean; resolve: () => void; settled: boolean }> = [];
  let holdCalls = true;

  // Ignores cancellation: it only notes that it was asked to stop.
  const provider: LlmProvider = {
    generateStructured: (input, _schema, options) => {
      if (!holdCalls) return Promise.resolve({ value: fakeMealDraftAnswer(input.user) });
      return new Promise((resolve) => {
        const call = {
          aborted: false,
          resolve: () => {
            call.settled = true;
            resolve({ value: fakeMealDraftAnswer(input.user) });
          },
          settled: false,
        };
        options.signal?.addEventListener('abort', () => (call.aborted = true), { once: true });
        held.push(call);
      });
    },
    model: 'test-model',
  };

  beforeAll(() => {
    const config = configuration({
      MEAL_DRAFTS_ALLOWANCE: '1000',
      MEAL_DRAFTS_MAX_CONCURRENT: '1',
      MEAL_DRAFTS_PROVIDER: 'fake',
      MEAL_DRAFTS_TIMEOUT_MS: '1000',
      MEAL_DRAFTS_USER_RATE_PER_MINUTE: '60',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 2 });
    ownerPool = new Pool({ connectionString: loadIntegrationTestConfiguration().migration.connectionString, max: 2 });
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS }),
      testOnlyMealDraftProvider: provider,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    held.length = 0;
    holdCalls = true;
    for (const userId of [ids.userDual, ids.userOrgA]) credentials.set(userId, await login(app, userId));
  });

  afterEach(() => {
    for (const call of held) if (!call.settled) call.resolve();
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function propose(userId: string) {
    const who = credentials.get(userId)!;
    return request(app)
      .post(`/api/orgs/${ids.orgA}/meals/draft-proposals`)
      .set('Cookie', who.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, who.csrf)
      .type('application/json')
      .send({ localDate: TODAY, text: TEXT, timeZone: 'Europe/Warsaw', version: 'meal-draft-1' });
  }

  it('answers 504 at the deadline but keeps the place until the call settles; the late answer reaches nobody', async () => {
    const first = await propose(ids.userDual).expect(504);
    expect(codeOf(first)).toBe('MEAL_DRAFT_TIMEOUT');
    expect(held).toHaveLength(1);
    expect(held[0]!.aborted).toBe(true);
    expect(held[0]!.settled).toBe(false);

    expect(codeOf(await propose(ids.userOrgA).expect(503))).toBe('MEAL_DRAFT_BUSY');
    expect(codeOf(await propose(ids.userDual).expect(429))).toBe('MEAL_DRAFT_IN_PROGRESS');
    expect(held).toHaveLength(1);

    holdCalls = false;
    held[0]!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const afterwards = await propose(ids.userOrgA).expect(200);
    expect(mealDraftProposalResponseSchema.parse(afterwards.body)).toMatchObject({ outcome: 'draft' });
  });
});
