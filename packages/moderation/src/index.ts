import type { ModerationResult } from '@meihua/core-types';

export interface ModerationConfig {
  minChars: number;
  maxChars: number;
  /** V7.2 运营口径开关：任何评论都视为一次提问（默认关闭）。 */
  treatAnyCommentAsQuestion?: boolean;
}

export class InvalidModerationResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModerationResultError';
  }
}

/** Validates the JSON contract expected from a future lightweight LLM classifier. */
export function assertValidModerationResult(value: unknown): asserts value is ModerationResult {
  if (!value || typeof value !== 'object') throw new InvalidModerationResultError('Moderation result must be an object.');
  const result = value as Partial<ModerationResult>;
  if (!['ALLOW', 'REJECT', 'UNCLEAR', 'CHAT_ONLY'].includes(result.decision ?? '')) throw new InvalidModerationResultError('Unknown moderation decision.');
  if (!['CAREER', 'RELATIONSHIP', 'STUDY', 'LIFE', 'FINANCE_GENERAL', 'OTHER', 'RISK'].includes(result.category ?? '')) throw new InvalidModerationResultError('Unknown moderation category.');
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) throw new InvalidModerationResultError('Invalid moderation confidence.');
  if (typeof result.reason !== 'string' || typeof result.normalizedQuestion !== 'string') throw new InvalidModerationResultError('Moderation text fields must be strings.');
}

const riskyPatterns = [
  /自杀|自殘|自残|轻生/i,
  /癌症|诊断|吃什么药|药物治疗/i,
  /什么时候死|死亡时间|寿命/i,
  /彩票|开奖号码|赌球|赌博|必赢/i,
  /犯罪|逃避警察|怎么违法/i,
  /稳赚|保证收益|必涨/i,
  /suicide|self[- ]?harm|cancer|medical diagnosis|which medicine|when will i die|lottery numbers?|gambling|guaranteed returns?|commit a crime|evade police/i,
];

const advertisingPattern = /(https?:\/\/|www\.|vx[:：]|微信[号號]|加我|推广|廣告)/i;
const emojiOnlyPattern = /^[\p{Extended_Pictographic}\s]+$/u;

function categoryFor(question: string): ModerationResult['category'] {
  if (/工作|职业|職業|事业|事業|跳槽|换工作|換工作|\bjob|career|work|business\b/iu.test(question)) return 'CAREER';
  if (/感情|恋爱|戀愛|对象|對象|婚姻|复合|復合|\blove|relationship|marriage|partner|reconcile\b/iu.test(question)) return 'RELATIONSHIP';
  if (/考试|考試|学业|學業|学校|學校|\bexam|study|school|university|course\b/iu.test(question)) return 'STUDY';
  if (/钱|錢|收入|理财|理財|投资|投資|\bmoney|income|finance|investment|salary\b/iu.test(question)) return 'FINANCE_GENERAL';
  return 'LIFE';
}

export function moderateQuestion(rawQuestion: string, config: ModerationConfig): ModerationResult {
  const normalizedQuestion = rawQuestion.trim().replace(/\s+/g, ' ');
  const effectiveLength = [...normalizedQuestion.replace(/[\p{P}\p{S}\s]/gu, '')].length;

  if (!normalizedQuestion || emojiOnlyPattern.test(normalizedQuestion)) {
    return { decision: 'REJECT', category: 'OTHER', confidence: 1, reason: 'empty_or_emoji_only', normalizedQuestion };
  }
  if (advertisingPattern.test(normalizedQuestion)) {
    return { decision: 'REJECT', category: 'OTHER', confidence: 0.99, reason: 'url_or_advertising', normalizedQuestion };
  }
  if (riskyPatterns.some((pattern) => pattern.test(normalizedQuestion))) {
    return { decision: 'REJECT', category: 'RISK', confidence: 0.98, reason: 'restricted_topic', normalizedQuestion };
  }
  if (effectiveLength < config.minChars) {
    return { decision: 'REJECT', category: 'OTHER', confidence: 0.9, reason: 'too_short', normalizedQuestion };
  }
  if (effectiveLength > config.maxChars) {
    return { decision: 'UNCLEAR', category: 'OTHER', confidence: 0.85, reason: 'too_long', normalizedQuestion };
  }
  const startsLikeQuestion = /^(?:should|can|could|will|would|is|are|am|do|does|did|may|might|what|when|where|why|how|who|which|deber[ií]a|puedo|puede|qu[eé]|c[oó]mo|cu[aá]ndo|por\s+qu[eé]|dois-je|puis-je|est-ce|quel(?:le)?|comment|quand|pourquoi|sollte|kann|wird|ist|sind|wie|wann|warum|was)\b/iu.test(normalizedQuestion);
  if (!startsLikeQuestion && !/[？?吗嗎]|是否|能不能|可不可以|适不适合|適不適合|如何|怎么|怎麼|会不会|會不會/.test(normalizedQuestion)) {
  // V7.2 运营口径：任何评论都视为一次提问——非疑问句也放行（仅保留广告/风险/长度过滤）。
  if (config.treatAnyCommentAsQuestion === true) {
    return { decision: 'ALLOW', category: categoryFor(normalizedQuestion), confidence: 0.92, reason: 'any_comment_as_question', normalizedQuestion };
  }
    return { decision: 'CHAT_ONLY', category: 'OTHER', confidence: 0.72, reason: 'not_a_clear_question', normalizedQuestion };
  }
  return {
    decision: 'ALLOW',
    category: categoryFor(normalizedQuestion),
    confidence: 0.92,
    reason: 'rule_allowed_question',
    normalizedQuestion,
  };
}
