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

function normalizeForQuestionRecognition(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’‛`´]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
}

function categoryFor(question: string): ModerationResult['category'] {
  if (/工作|职业|職業|事业|事業|跳槽|换工作|換工作|仕事|転職|직업|이직|job|career|work|business|trabajo|travail|arbeit|trabalho|работ/iu.test(question)) return 'CAREER';
  if (/感情|恋爱|戀愛|对象|對象|婚姻|复合|復合|恋愛|結婚|연애|결혼|관계|love|relationship|marriage|partner|reconcile|amor|relation|beziehung|relacionamento|любовь|отношения/iu.test(question)) return 'RELATIONSHIP';
  if (/考试|考試|学业|學業|学校|學校|試験|勉強|시험|공부|exam|study|school|university|course|examen|étude|prüfung|estudo|экзамен|учёба/iu.test(question)) return 'STUDY';
  if (/钱|錢|收入|理财|理財|投资|投資|お金|収入|돈|수입|money|income|finance|investment|salary|dinero|argent|geld|dinheiro|деньги|доход/iu.test(question)) return 'FINANCE_GENERAL';
  return 'LIFE';
}

export function moderateQuestion(rawQuestion: string, config: ModerationConfig): ModerationResult {
  const normalizedQuestion = normalizeForQuestionRecognition(rawQuestion);
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
  const startsLikeQuestion = /^(?:should|can|could|will|would|is|are|am|do|does|did|may|might|have|has|had|what(?:'s|\s+(?:is|are|was|will|would|should|can))?|when(?:'s|\s+(?:is|will|would|should|can))?|where(?:'s|\s+(?:is|are|will|would|should|can))?|why(?:'s|\s+(?:is|are|will|would|did|does))?|how(?:'s|\s+(?:is|are|will|would|should|can|do|does))?|who(?:'s|\s+(?:is|will|would|should|can))?|which(?:\s+(?:one|way|job|choice))?|can't|cannot|couldn't|won't|wouldn't|shouldn't|isn't|aren't|do\s+you\s+think|i\s+wonder|i(?:'d|\s+would)\s+like\s+to\s+know|please\s+(?:tell|read|help|advise)|any\s+chance|[¿]?deber[ií]a|[¿]?puedo|[¿]?puede|[¿]?podr[eé]|[¿]?ser[aá]\s+que|[¿]?quisiera\s+saber|[¿]?me\s+gustar[ií]a\s+saber|[¿]?qu[eé]|[¿]?c[oó]mo|[¿]?cu[aá]ndo|[¿]?por\s+qu[eé]|dois-je|puis-je|vais-je|est-ce(?:\s+que)?|qu'est-ce|je\s+voudrais\s+savoir|j'aimerais\s+savoir|quel(?:le)?|comment|quand|pourquoi|sollte\s+ich|kann\s+ich|werde\s+ich|habe\s+ich|werde|wird|ist|sind|wie|wann|warum|was|wer|welche?|devo|posso|poderei|ser[aá]\s+que|gostaria\s+de\s+saber|quando|como|por\s+que|qual|стоит\s+ли|смогу\s+ли|можно\s+ли|будет\s+ли|когда|как|почему|что|где|какой)(?=$|[\s,:;.!?¿？'’"-])/iu.test(normalizedQuestion);
  const hasExplicitQuestionPunctuation = /[?？¿]/u.test(normalizedQuestion);
  const hasCjkQuestionShape = /吗|嗎|是否|能不能|可不可以|适不适合|適不適合|如何|怎么办|怎麼辦|怎么|怎麼|会不会|會不會|什么时候|何时|でしょうか|ですか|ますか|どうすれば|できますか|どうしたら|どうなる|いつ|かな|のですか|のかな|할까요|인가요|나요|까요|습니까|나요|어떻게|언제|무엇|어느|가능할까요/u.test(normalizedQuestion);
  if (!startsLikeQuestion && !hasExplicitQuestionPunctuation && !hasCjkQuestionShape) {
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
