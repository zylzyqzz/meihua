import { describe, expect, it } from 'vitest';
import { InvalidAnswerContentError, OpenAICompatibleAnswerComposer, RuleBasedAnswerComposer, assertNoGenericAnswerContent, assertValidAnswerContent, concludeReading, countSpeechUnits, estimateSpeechLengthTarget, formatHexagramDisplayName } from './index.js';

describe('answer schema guard', () => {
  it('rejects the retired generic decision filler', () => {
    expect(() => assertNoGenericAnswerContent({
      opening: '', speech: 'For daily life, one clear decision at a time keeps things steady.',
      keywords: [], closing: '', estimatedSeconds: 30,
    })).toThrow('ANSWER_CONTAINS_FORBIDDEN_GENERIC_COPY');
  });

  it('formats hexagram names for the selected broadcast language', () => {
    expect(formatHexagramDisplayName(3, '水雷屯', 'en')).toBe('Hexagram 3 · Difficulty at the Beginning');
    expect(formatHexagramDisplayName(3, '水雷屯', 'zh-CN')).toBe('第3卦 · 水雷屯');
    expect(formatHexagramDisplayName(3, '水雷屯', 'es')).toBe('Hexagrama 3 · Difficulty at the Beginning');
  });
  it('accepts the integration contract', () => {
    expect(() => assertValidAnswerContent({ opening: '', speech: '内容', keywords: ['关键词'], closing: '', estimatedSeconds: 12 })).not.toThrow();
  });

  it('rejects malformed provider output', () => {
    expect(() => assertValidAnswerContent({ speech: '内容' })).toThrow(InvalidAnswerContentError);
  });

  it('calls an OpenAI-compatible endpoint with strict structured output', async () => {
    let requestBody: Record<string, any> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ opening: '', speech: 'Hexagram 1 · The Creative shows that momentum is available, but your first move must be deliberate. The moving line at the beginning says build position before demanding results. The change toward Treading asks you to respect boundaries, timing, and the people whose support you need. Proceed with one visible step this week, keep the commitment modest, and measure the response before expanding. Confidence helps, but discipline protects the opportunity. The favorable window opens after preparation, not before.', keywords: ['Hexagram 1'], closing: '', estimatedSeconds: 20 }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const answer = await new OpenAICompatibleAnswerComposer({ baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'secret-key', fetcher }).compose({
      username: 'Viewer', question: 'Proceed?', targetSeconds: 20,
      result: { primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] }, movingLines: [1], interpretationFacts: ['主卦乾为天'], engineVersion: 'test' },
    });
    expect(requestBody?.response_format?.json_schema?.strict).toBe(true);
    const requestedLength = JSON.parse(requestBody?.messages?.[1]?.content).lengthTarget;
    expect(requestedLength).toEqual(estimateSpeechLengthTarget('en', 20, 1));
    expect(answer).toMatchObject({ estimatedSeconds: 20, opening: '', closing: '' });
    expect(answer.speech.startsWith('Hexagram 1')).toBe(true);
  });

  it('uses DeepSeek JSON-object mode and retains the local answer contract', async () => {
    let requestBody: Record<string, any> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ opening: '', speech: 'Hexagram 1 · The Creative shows that momentum is available, but your first move must be deliberate. The moving line at the beginning says build position before demanding results. The change toward Treading asks you to respect boundaries, timing, and the people whose support you need. Proceed with one visible step this week, keep the commitment modest, and measure the response before expanding. Confidence helps, but discipline protects the opportunity. The favorable window opens after preparation, not before.', keywords: ['Hexagram 1'], closing: '', estimatedSeconds: 20 }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const answer = await new OpenAICompatibleAnswerComposer({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'secret-key', fetcher }).compose({
      username: 'Viewer', question: 'Proceed?', targetSeconds: 20,
      result: { primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] }, movingLines: [1], interpretationFacts: ['主卦乾为天'], engineVersion: 'test' },
    });
    expect(requestBody?.response_format).toEqual({ type: 'json_object' });
    expect(answer).toMatchObject({ estimatedSeconds: 20, opening: '', closing: '' });
  });

  it('scales narration length by language, duration and configured voice speed', () => {
    expect(estimateSpeechLengthTarget('en', 20, 1)).toMatchObject({ unit: 'WORDS', target: 80 });
    expect(estimateSpeechLengthTarget('en', 60, 1).target).toBeGreaterThan(estimateSpeechLengthTarget('en', 20, 1).target);
    expect(estimateSpeechLengthTarget('zh-CN', 30, 1.2)).toMatchObject({ unit: 'CHARACTERS', target: 144 });
    expect(estimateSpeechLengthTarget('en', 30, 1.25).target).toBeGreaterThan(estimateSpeechLengthTarget('en', 30, 0.8).target);
  });

  it('uses more narration for longer gift-duration tiers without speeding up the voice', async () => {
    const composer = new RuleBasedAnswerComposer();
    const input = {
      username: 'Viewer', question: 'Should I proceed?', language: 'en' as const, speechRate: 1,
      result: {
        primary: { name: '火风鼎', number: 50, upperTrigram: '离', lowerTrigram: '巽', lines: [] },
        changed: { name: '天风姤', number: 44, upperTrigram: '乾', lowerTrigram: '巽', lines: [] },
        movingLines: [5], relations: ['体生用，自身投入较多'], timingSignals: [], interpretationFacts: [], engineVersion: 'test',
      },
    };
    const brief = await composer.compose({ ...input, targetSeconds: 20 });
    const standard = await composer.compose({ ...input, targetSeconds: 40 });
    const complete = await composer.compose({ ...input, targetSeconds: 60 });
    expect(countSpeechUnits(`${brief.opening}${brief.speech}${brief.closing}`, 'en')).toBeLessThan(countSpeechUnits(`${standard.opening}${standard.speech}${standard.closing}`, 'en'));
    expect(countSpeechUnits(`${standard.opening}${standard.speech}${standard.closing}`, 'en')).toBeLessThanOrEqual(countSpeechUnits(`${complete.opening}${complete.speech}${complete.closing}`, 'en'));
  });

  it('composes usable speech only from structured facts', async () => {
    const result = await new RuleBasedAnswerComposer().compose({
      username: '观众', question: '现在适合推进计划吗？', targetSeconds: 40,
      result: {
        primary: { name: '乾为天', upperTrigram: '乾', lowerTrigram: '乾', lines: [] },
        changed: { name: '天火同人', upperTrigram: '乾', lowerTrigram: '离', lines: [] },
        movingLines: [2], relations: ['用生体，外部条件对自身形成助力'], timingSignals: ['动爻在第 2 爻', '变化先从内部展开'], interpretationFacts: [], engineVersion: 'test',
      },
    });
    expect(result.speech).toContain('乾为天');
    expect(result.speech).toContain('天火同人');
    expect(result.speech).not.toContain('Mock');
    expect(result.estimatedSeconds).toBe(40);
    expect(() => assertValidAnswerContent(result)).not.toThrow();
  });

  it('starts directly with the calculated result and omits template padding', async () => {
    const result = await new RuleBasedAnswerComposer().compose({
      username: 'Viewer', question: 'Should I take one careful step forward?', targetSeconds: 28, language: 'en',
      result: {
        primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] },
        changed: { name: '天泽履', number: 10, upperTrigram: '乾', lowerTrigram: '兑', lines: [] },
        movingLines: [1], relations: ['体用比和，整体条件相互呼应'], timingSignals: [], interpretationFacts: [], engineVersion: 'test',
      },
    });
    expect(result.opening).toBe('');
    expect(result.closing).toBe('');
    expect(result.speech.startsWith('Hexagram 1')).toBe(true);
    expect(result.speech).not.toContain('Should I take one careful step forward');
  });

  it('produces schema-safe localized speech for every built-in TikTok language', async () => {
    const languages = ['en', 'zh-CN', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'] as const;
    for (const language of languages) {
      const answer = await new RuleBasedAnswerComposer().compose({
        username: 'Viewer', question: 'Should I proceed?', targetSeconds: 38, language,
        result: {
          primary: { name: '水泽节', number: 60, upperTrigram: '坎', lowerTrigram: '兑', lines: [] },
          changed: { name: '风泽中孚', number: 61, upperTrigram: '巽', lowerTrigram: '兑', lines: [] },
          movingLines: [6], relations: ['体生用，自身投入较多'], timingSignals: [], interpretationFacts: [], engineVersion: 'test',
        },
      });
      expect(answer.speech.length).toBeGreaterThan(40);
      expect(answer.speech).not.toMatch(/[.!?][A-ZА-Я]/u);
      expect(() => assertValidAnswerContent(answer)).not.toThrow();
    }
  });
});

describe('spoken duration tiers and fact traceability', () => {
  const fixture = {
    primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1 | 2 | 3 | 4 | 5 | 6, yinYang: 'YANG' as const, moving: index === 3 })) },
    mutual: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1 | 2 | 3 | 4 | 5 | 6, yinYang: 'YANG' as const, moving: false })) },
    changed: { name: '天泽履', number: 10, upperTrigram: '乾', lowerTrigram: '兑', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1 | 2 | 3 | 4 | 5 | 6, yinYang: (index <= 3 ? 'YIN' : 'YANG') as 'YIN' | 'YANG', moving: false })) },
    movingLines: [3],
    bodyTrigram: '乾', useTrigram: '乾',
    relations: ['体用比和，整体条件相互呼应'],
    interpretationFacts: ['本卦为乾为天'],
    engineVersion: 'test',
  };

  it('stays inside the calibrated length target at the 20/30/40/60 second tiers', async () => {
    const composer = new RuleBasedAnswerComposer();
    for (const language of ['en', 'zh-CN'] as const) {
      for (const tier of [20, 30, 40, 60]) {
        const answer = await composer.compose({ username: 'Viewer', question: 'Should I change jobs this year?', result: fixture, targetSeconds: tier, language });
        expect(answer.estimatedSeconds, `${language} @ ${tier}s`).toBe(tier);
        const target = estimateSpeechLengthTarget(language, tier, 1);
        const units = countSpeechUnits(`${answer.opening}${answer.speech}${answer.closing}`, language);
        expect(units, `${language} @ ${tier}s units ${units} vs [${target.minimum}, ${target.maximum}]`).toBeGreaterThanOrEqual(target.minimum);
        expect(units, `${language} @ ${tier}s`).toBeLessThanOrEqual(target.maximum);
      }
    }
  });

  it('keeps every English claim traceable to structured hexagram facts', async () => {
    const composer = new RuleBasedAnswerComposer();
    const answer = await composer.compose({ username: 'Viewer', question: 'Should I change jobs this year?', result: fixture, targetSeconds: 60, language: 'en' });
    const text = `${answer.opening}${answer.speech}${answer.closing}`;
    expect(text).toContain('Hexagram 1');
    expect(text).toContain('The Creative');
    expect(text).toContain('Line 3');
    // No invented hexagram: every hexagram number mentioned is from the cast.
    const mentioned = [...text.matchAll(/Hexagram (\d+)/g)].map((match) => Number(match[1]));
    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.every((number) => [1, 10].includes(number))).toBe(true);
    // The spoken result is intentionally direct: no greeting or disclaimer.
    expect(answer.opening).toBe('');
    expect(answer.closing).toBe('');
    expect(answer.speech.startsWith('Hexagram 1')).toBe(true);
    expect(answer.speech.toLowerCase()).not.toContain('reflection');
  });

  it('keeps Chinese claims traceable to the same facts', async () => {
    const composer = new RuleBasedAnswerComposer();
    const answer = await composer.compose({ username: '观众', question: '今年适合换工作吗？', result: fixture, targetSeconds: 40, language: 'zh-CN' });
    const text = `${answer.opening}${answer.speech}${answer.closing}`;
    expect(text).toContain('乾为天');
    expect(text).toContain('第3爻动');
    expect(text).toContain('天泽履');
  });
});

describe('Layer-2 rule conclusion (concludeReading)', () => {
  const balance = {
    primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] },
    mutual: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] },
    changed: { name: '天泽履', number: 10, upperTrigram: '乾', lowerTrigram: '兑', lines: [] },
    movingLines: [3], bodyTrigram: '乾', useTrigram: '乾',
    relations: ['体用比和，整体条件相互呼应'], interpretationFacts: [], engineVersion: 't',
  };
  const resist = { ...balance, relations: ['用克体，外部阻力较强，宜先稳后动'], movingLines: [5] };

  it('is deterministic and builds a complete truth set from the cast facts', () => {
    const a = concludeReading({ result: balance, language: 'en', category: 'CAREER' });
    const b = concludeReading({ result: balance, language: 'en', category: 'CAREER' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.schemaVersion).toBe(1);
    expect(a.hexagram).toMatchObject({ primary: { name: '乾为天', number: 1 }, changed: { name: '天泽履', number: 10 }, movingLine: 3 });
    expect(a.tiYong).toMatchObject({ relation: 'balance', direction: 'BALANCED' });
    expect(a.timing).toBe('EARLY');
    expect(a.facts).toContain('乾为天 (1)');
    expect(a.facts.some((fact) => fact.startsWith('Moving line'))).toBe(true);
    expect(a.judgmentPoints).toHaveLength(3); // direction + category + timing
    const life = concludeReading({ result: balance, language: 'en', category: 'LIFE' });
    expect(life.category).toBeUndefined();
    expect(life.judgmentPoints).toHaveLength(2);
  });

  it('maps every 体用 relation to its rule direction', () => {
    expect(concludeReading({ result: { ...balance, relations: ['用生体，外部条件对自身形成助力'] }, language: 'en' }).tiYong.direction).toBe('FAVORABLE');
    expect(concludeReading({ result: { ...balance, relations: ['体生用，自身投入较多，宜控制消耗'] }, language: 'en' }).tiYong.direction).toBe('INVEST');
    expect(concludeReading({ result: { ...balance, relations: ['体克用，自身有主动掌控空间'] }, language: 'en' }).tiYong.direction).toBe('CONTROLLABLE');
    expect(concludeReading({ result: resist, language: 'en' }).tiYong.direction).toBe('CAUTION');
    expect(concludeReading({ result: resist, language: 'en' }).timing).toBe('LATER');
  });

  it('adds the category-specific judgment point in English, Spanish and Chinese', () => {
    expect(concludeReading({ result: balance, language: 'en', category: 'RELATIONSHIP' }).judgmentPoints[1]).toContain('people and bonds');
    expect(concludeReading({ result: balance, language: 'es', category: 'RELATIONSHIP' }).judgmentPoints[1]).toContain('vínculos');
    expect(concludeReading({ result: balance, language: 'zh-CN', category: 'STUDY' }).judgmentPoints[1]).toContain('学业');
    // Without a category the conclusion stays at direction + timing only.
    expect(concludeReading({ result: balance, language: 'en' }).judgmentPoints).toHaveLength(2);
  });
});

describe('Layer-3 voice prompt contract', () => {
  it('sends only the structured conclusion to the LLM, never the raw result', async () => {
    let requestBody: Record<string, any> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ opening: '', speech: 'Hexagram 1 · The Creative points to a favorable opening when you act with structure. The third moving line warns that visible progress can invite pressure, so keep your plan practical and do not overpromise. The change toward Treading favors careful coordination, clear limits, and respect for the pace of others. In career matters, make the next proposal specific, prepare the evidence, and wait for a concrete response before committing more time or resources. Your advantage grows through disciplined follow-through.', keywords: ['Hexagram 1'], closing: '', estimatedSeconds: 20 }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = {
      primary: { name: '乾为天', number: 1, upperTrigram: '乾', lowerTrigram: '乾', lines: [] },
      changed: { name: '天泽履', number: 10, upperTrigram: '乾', lowerTrigram: '兑', lines: [] },
      movingLines: [3], relations: ['体用比和，整体条件相互呼应'], interpretationFacts: ['原始字段不该出现在提示词里'], engineVersion: 't',
    };
    await new OpenAICompatibleAnswerComposer({ baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'secret', fetcher }).compose({
      username: 'Viewer', question: 'Proceed?', result, targetSeconds: 20, language: 'en', category: 'CAREER',
    });
    const system = requestBody?.messages?.[0]?.content as string;
    expect(system).toContain('voice layer');
    expect(system).toContain('NEVER add, change, or invent');
    expect(system).toContain('US TikTok');
    expect(system).toContain('Latin American');
    const user = JSON.parse(requestBody?.messages?.[1]?.content);
    expect(user.conclusion).toBeDefined();
    expect(user.conclusion.hexagram.primary.number).toBe(1);
    expect(user.conclusion.judgmentPoints.length).toBeGreaterThanOrEqual(1);
    // The raw cast payload and its free-form fields never reach the model.
    expect(user.meihua).toBeUndefined();
    expect(JSON.stringify(requestBody)).not.toContain('原始字段不该出现在提示词里');
    expect(user.lengthTarget).toEqual(estimateSpeechLengthTarget('en', 20, 1));
  });
});
