import { describe, expect, it } from 'vitest';
import { assertValidModerationResult, InvalidModerationResultError, moderateQuestion } from './index.js';

const config = { minChars: 4, maxChars: 120 };

describe('rule moderation', () => {
  it('allows a clear career question', () => {
    expect(moderateQuestion('今年适不适合换工作？', config)).toMatchObject({ decision: 'ALLOW', category: 'CAREER' });
  });

  it('rejects restricted questions before any LLM step', () => {
    expect(moderateQuestion('帮我预测彩票开奖号码', config)).toMatchObject({ decision: 'REJECT', category: 'RISK' });
  });

  it('rejects too-short chat', () => {
    expect(moderateQuestion('你好', config)).toMatchObject({ decision: 'REJECT', reason: 'too_short' });
  });

  it('recognizes an English question without terminal punctuation', () => {
    expect(moderateQuestion('Should I change jobs this year', config)).toMatchObject({ decision: 'ALLOW', category: 'CAREER' });
  });

  it.each([
    ['¿Cuándo mejorará mi trabajo?', 'CAREER'],
    ['Quisiera saber si encontraré un trabajo mejor', 'CAREER'],
    ['Comment puis-je améliorer ma relation ?', 'RELATIONSHIP'],
    ["J'aimerais savoir si cette relation va durer", 'RELATIONSHIP'],
    ['Sollte ich dieses Jahr die Arbeit wechseln', 'CAREER'],
    ['Habe ich mit diesem Projekt Erfolg', 'LIFE'],
    ['転職したほうがいいですか', 'CAREER'],
    ['この仕事を続けるべきかな', 'CAREER'],
    ['언제 직업을 바꾸는 게 좋을까요', 'CAREER'],
    ['이 관계가 앞으로 어떻게 될까요', 'RELATIONSHIP'],
    ['Quando meu dinheiro vai melhorar?', 'FINANCE_GENERAL'],
    ['Gostaria de saber se devo mudar de trabalho', 'CAREER'],
    ['Когда улучшатся мои отношения?', 'RELATIONSHIP'],
    ['Можно ли мне сейчас менять работу', 'CAREER'],
    ["What's next for my career", 'CAREER'],
    ["I'd like to know whether this relationship will last", 'RELATIONSHIP'],
  ])('recognizes a supported-language question: %s', (question, category) => {
    expect(moderateQuestion(question, config)).toMatchObject({ decision: 'ALLOW', category });
  });

  it.each([
    'I love your voice',
    'Nice work everyone',
    'Career content is interesting',
    'amor para todos',
    '仕事が好きです',
    '연애 노래 좋아요',
  ])('does not turn multilingual topic chatter into a question: %s', (chat) => {
    expect(moderateQuestion(chat, config)).toMatchObject({ decision: 'CHAT_ONLY' });
  });

  it('guards future LLM classifier JSON', () => {
    expect(() => assertValidModerationResult({ decision: 'ALLOW', category: 'CAREER', confidence: 0.9, reason: 'ok', normalizedQuestion: '问题？' })).not.toThrow();
    expect(() => assertValidModerationResult({ decision: 'MAYBE' })).toThrow(InvalidModerationResultError);
  });
});
