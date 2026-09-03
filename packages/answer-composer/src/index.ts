import type { AnswerContent, ContentLanguage, MeihuaResult, ModerationResult } from '@meihua/core-types';

export type AnswerComposerInput = {
  username: string;
  question: string;
  result: MeihuaResult;
  targetSeconds?: number;
  language?: ContentLanguage;
  /** TTS playback speed. A faster voice needs more text for the same target duration. */
  speechRate?: number;
  /** Moderator category; feeds the Layer-2 category-specific judgment point. */
  category?: ModerationResult['category'];
};

export interface SpeechLengthTarget {
  unit: 'WORDS' | 'CHARACTERS';
  target: number;
  minimum: number;
  maximum: number;
  targetSeconds: number;
  speechRate: number;
}

export interface AnswerComposer {
  compose(input: AnswerComposerInput): Promise<AnswerContent>;
}

export class InvalidAnswerContentError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidAnswerContentError'; }
}

export function assertValidAnswerContent(value: unknown): asserts value is AnswerContent {
  if (!value || typeof value !== 'object') throw new InvalidAnswerContentError('Answer must be an object.');
  const answer = value as Partial<AnswerContent>;
  if (typeof answer.opening !== 'string' || typeof answer.speech !== 'string' || typeof answer.closing !== 'string') throw new InvalidAnswerContentError('Answer text fields must be strings.');
  if (!Array.isArray(answer.keywords) || answer.keywords.length > 5 || answer.keywords.some((keyword) => typeof keyword !== 'string' || keyword.length > 32)) throw new InvalidAnswerContentError('Answer keywords are invalid.');
  if (!Number.isInteger(answer.estimatedSeconds) || (answer.estimatedSeconds ?? 0) < 1 || (answer.estimatedSeconds ?? 0) > 120) throw new InvalidAnswerContentError('Estimated seconds must be an integer between 1 and 120.');
}

const unitsPerSecond: Record<ContentLanguage, { unit: SpeechLengthTarget['unit']; rate: number }> = {
  // 20 seconds is about 50 spoken English words / Chinese characters at a
  // calm live cadence. The agreed +60% content tier therefore targets about
  // 80 units at 20 seconds and 120 units at 30 seconds.
  en: { unit: 'WORDS', rate: 2.5 },
  'zh-CN': { unit: 'CHARACTERS', rate: 2.5 },
  es: { unit: 'WORDS', rate: 1.1 },
  fr: { unit: 'WORDS', rate: 1.05 },
  de: { unit: 'WORDS', rate: 1 },
  ja: { unit: 'CHARACTERS', rate: 2.2 },
  ko: { unit: 'WORDS', rate: 1.05 },
  pt: { unit: 'WORDS', rate: 1.1 },
  ru: { unit: 'WORDS', rate: 1 },
};

/**
 * The first direct-result scripts were technically valid but too short for a
 * live reading. Keep the operator's 20/30/60 second entitlement unchanged,
 * while reserving 60% more spoken units for the actual result and advice.
 * TTS duration correction remains responsible for fitting the final WAV to
 * the entitlement; this multiplier only controls content density.
 */
export const SPEECH_CONTENT_MULTIPLIER = 1.6;

export function estimateSpeechLengthTarget(language: ContentLanguage, targetSeconds: number, speechRate = 1): SpeechLengthTarget {
  const seconds = Math.max(10, Math.min(120, Math.round(targetSeconds)));
  const speed = Math.max(0.25, Math.min(2, speechRate || 1));
  const profile = unitsPerSecond[language];
  const target = Math.max(12, Math.round(seconds * speed * profile.rate * SPEECH_CONTENT_MULTIPLIER));
  return {
    unit: profile.unit,
    target,
    minimum: Math.max(8, Math.floor(target * 0.88)),
    maximum: Math.ceil(target * 1.12),
    targetSeconds: seconds,
    speechRate: speed,
  };
}

export function countSpeechUnits(text: string, language: ContentLanguage): number {
  if (unitsPerSecond[language].unit === 'CHARACTERS') {
    return [...text.normalize('NFKC')].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  }
  return text.normalize('NFKC').trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export interface AnswerLengthCheck {
  ok: boolean;
  actual: number;
  target: SpeechLengthTarget;
  reason?: string;
}

/**
 * Validate the complete spoken payload, including opening and disclaimer.
 * The queue's seconds are meaningless unless this check passes before TTS.
 */
export function validateAnswerLength(answer: AnswerContent, language: ContentLanguage, targetSeconds: number, speechRate = 1): AnswerLengthCheck {
  const target = estimateSpeechLengthTarget(language, targetSeconds, speechRate);
  const actual = countSpeechUnits(`${answer.opening}${answer.speech}${answer.closing}`, language);
  const ok = actual >= target.minimum && actual <= target.maximum;
  return {
    ok, actual, target,
    reason: ok ? undefined : `ANSWER_LENGTH_OUT_OF_RANGE:${actual}:[${target.minimum},${target.maximum}]`,
  };
}

export function withAnswerLengthMetrics(answer: AnswerContent, language: ContentLanguage, targetSeconds: number, speechRate = 1): AnswerContent {
  const check = validateAnswerLength(answer, language, targetSeconds, speechRate);
  return {
    ...answer,
    speechUnits: check.actual,
    targetSpeechUnits: check.target.target,
    minimumSpeechUnits: check.target.minimum,
    maximumSpeechUnits: check.target.maximum,
    contentLanguage: language,
  };
}

export function assertAnswerLengthTarget(answer: AnswerContent, language: ContentLanguage, targetSeconds: number, speechRate = 1): asserts answer is AnswerContent {
  const check = validateAnswerLength(answer, language, targetSeconds, speechRate);
  if (!check.ok) throw new InvalidAnswerContentError(check.reason ?? 'Answer length is outside the requested duration tier.');
}

const hexagramEnglish: Record<number, string> = {
  1:'The Creative',2:'The Receptive',3:'Difficulty at the Beginning',4:'Youthful Folly',5:'Waiting',6:'Conflict',7:'The Army',8:'Holding Together',9:'Small Taming',10:'Treading',11:'Peace',12:'Standstill',13:'Fellowship',14:'Great Possession',15:'Modesty',16:'Enthusiasm',17:'Following',18:'Repairing What Is Spoiled',19:'Approach',20:'Contemplation',21:'Biting Through',22:'Grace',23:'Splitting Apart',24:'Return',25:'Innocence',26:'Great Taming',27:'Nourishment',28:'Great Exceeding',29:'The Abysmal Water',30:'The Clinging Fire',31:'Influence',32:'Duration',33:'Retreat',34:'Great Power',35:'Progress',36:'Darkening of the Light',37:'The Family',38:'Opposition',39:'Obstruction',40:'Deliverance',41:'Decrease',42:'Increase',43:'Breakthrough',44:'Coming to Meet',45:'Gathering Together',46:'Pushing Upward',47:'Oppression',48:'The Well',49:'Revolution',50:'The Cauldron',51:'The Arousing Thunder',52:'Keeping Still',53:'Development',54:'The Marrying Maiden',55:'Abundance',56:'The Wanderer',57:'The Gentle Wind',58:'The Joyous Lake',59:'Dispersion',60:'Limitation',61:'Inner Truth',62:'Small Exceeding',63:'After Completion',64:'Before Completion',
};

// The cast must be audible in the answer, not only shown as a number in the
// overlay. These are fixed plain-language renderings of the 64 primary
// hexagram themes; they make two different casts produce different judgments
// even when their relationship/category happens to match.
const hexagramJudgmentEnglish: Record<number, string> = {
  1: 'The Creative calls for direct initiative, disciplined effort, and the patience to carry a strong plan through.',
  2: 'The Receptive favors support, preparation, and steady cooperation before trying to force the outcome.',
  3: 'Difficulty at the Beginning says the result is not ready yet; establish the foundation before expanding.',
  4: 'Youthful Folly asks you to learn from the right guide and stop guessing where knowledge is missing.',
  5: 'Waiting favors calm preparation and the right timing; pressure will not make the next step mature faster.',
  6: 'Conflict warns against escalation; state the boundary clearly and settle the real point of disagreement.',
  7: 'The Army requires discipline, clear roles, and one coordinated direction instead of scattered effort.',
  8: 'Holding Together favors choosing reliable allies and building trust around one shared purpose.',
  9: 'Small Taming points to gradual restraint: make small adjustments until conditions are ready for a larger move.',
  10: 'Treading says progress is possible through careful conduct, respect for limits, and attention to each step.',
  11: 'Peace shows a temporary opening for cooperation; use the flow to connect people and move the work forward.',
  12: 'Standstill says the channel is blocked for now; protect your position and do not waste force on dead resistance.',
  13: 'Fellowship favors open alignment with the right people, shared principles, and a visible common goal.',
  14: 'Great Possession brings resources and influence; manage them visibly and avoid treating abundance as permission to overreach.',
  15: 'Modesty makes the result durable: keep the claim measured, do the work, and let the evidence speak.',
  16: 'Enthusiasm supplies momentum, but it must be organized into a schedule before it becomes a result.',
  17: 'Following favors adapting to the right signal while keeping your own standard instead of copying every influence.',
  18: 'Repairing What Is Spoiled asks you to correct the old cause directly before starting another cycle.',
  19: 'Approach shows a useful opening; meet the situation closely, listen well, and act before the window narrows.',
  20: 'Contemplation favors stepping back to see the whole pattern before making a public or irreversible choice.',
  21: 'Biting Through requires one clear decision that removes the obstacle rather than another round of delay.',
  22: 'Grace improves presentation and connection, but appearance must serve the substance instead of replacing it.',
  23: 'Splitting Apart says weak layers are falling away; preserve the essential part and stop defending what no longer holds.',
  24: 'Return favors coming back to the correct track through one simple repeated action, not a dramatic restart.',
  25: 'Innocence rewards honest action without manipulation; keep the motive clean and respond to facts as they arrive.',
  26: 'Great Taming stores power through restraint, training, and preparation for a moment when action can be decisive.',
  27: 'Nourishment asks what you are feeding through words, habits, money, and attention, then correct the source.',
  28: 'Great Exceeding shows an unusual load; reinforce the structure and make the crucial decision without pretending it is ordinary.',
  29: 'The Abysmal Water calls for repeated caution: use a reliable routine and cross the difficult section one step at a time.',
  30: 'The Clinging Fire favors clarity and continuity; keep close to the right principle instead of chasing every spark.',
  31: 'Influence works through sincere attraction and responsive contact, not pressure or performance.',
  32: 'Duration favors consistency; a modest action repeated over time matters more than a short burst of intensity.',
  33: 'Retreat is strategic here: step back from the losing position, preserve strength, and choose the next ground.',
  34: 'Great Power gives capacity to act, but only controlled force produces a clean result instead of damage.',
  35: 'Progress supports visible advancement; show the work, accept recognition, and keep the next improvement practical.',
  36: 'Darkening of the Light advises protecting your clarity in a difficult environment and avoiding needless exposure.',
  37: 'The Family puts the result in roles, routines, and responsibilities; stability grows when each person knows their part.',
  38: 'Opposition means interests differ; name the difference, protect the shared minimum, and do not demand identical views.',
  39: 'Obstruction says the direct route is blocked; seek help, change the angle, and solve the bottleneck before advancing.',
  40: 'Deliverance favors releasing the pressure after the knot is identified; finish the correction and move on cleanly.',
  41: 'Decrease asks for a deliberate reduction of excess so the essential goal can regain strength.',
  42: 'Increase favors adding support where it creates real growth; invest in the step that improves the whole system.',
  43: 'Breakthrough requires a firm public decision, clear evidence, and no return to the compromise that caused the blockage.',
  44: 'Coming to Meet warns that a strong influence may arrive suddenly; set standards before entering the contact.',
  45: 'Gathering Together favors assembling people and resources around one concrete purpose, then making the group useful.',
  46: 'Pushing Upward shows gradual progress through persistence, mentors, and small gains that accumulate.',
  47: 'Oppression says resources or energy are constrained; protect the essential promise and ask for practical support.',
  48: 'The Well points to a stable source that serves many; maintain the source instead of chasing a temporary shortcut.',
  49: 'Revolution supports a necessary change of method, but the old pattern must be clearly outgrown before the switch.',
  50: 'The Cauldron transforms raw material into value; improve the process, the container, and the people carrying it.',
  51: 'The Arousing Thunder brings a sharp jolt; recover your footing quickly and turn the shock into a new rhythm.',
  52: 'Keeping Still favors stopping at the right boundary, quieting the impulse, and refusing to add unnecessary movement.',
  53: 'Development is gradual and reliable; let trust, skill, and commitment mature in their proper order.',
  54: 'The Marrying Maiden warns against accepting a secondary position without checking whether the terms respect your value.',
  55: 'Abundance brings a full moment, but the window is temporary; act clearly while keeping priorities visible.',
  56: 'The Wanderer favors light commitments, respectful conduct, and careful use of resources while conditions remain unsettled.',
  57: 'The Gentle Wind works through persistence and repeated small influence rather than one forceful announcement.',
  58: 'The Joyous Lake favors open conversation and shared enjoyment, provided the exchange remains sincere and bounded.',
  59: 'Dispersion asks you to dissolve the fear or isolation blocking cooperation, then gather the purpose again.',
  60: 'Limitation gives the result a workable boundary; define what is enough and do not turn discipline into excess.',
  61: 'Inner Truth favors sincerity that can be demonstrated; align the words, the motive, and the observable action.',
  62: 'Small Exceeding advises attention to details and modest steps; do not attempt a grand gesture above the situation.',
  63: 'After Completion says the main work is done but maintenance is critical; guard the result during the transition.',
  64: 'Before Completion shows a process near its turn; finish the sequence carefully instead of celebrating too early.',
};

const movingLineJudgmentEnglish: Record<number, string> = {
  1: 'The first line makes the immediate foundation decisive: start quietly and verify the first response.',
  2: 'The second line favors cooperation and a practical adjustment before the situation becomes public.',
  3: 'The third line marks a turning point: do not push through a weak position without changing the method.',
  4: 'The fourth line moves the issue outward; prepare the message, allies, and timing before acting.',
  5: 'The fifth line puts responsibility at the center; lead by keeping the decision fair and measured.',
  6: 'The sixth line shows the consequence of the whole pattern; close the cycle and avoid repeating its excess.',
};

function primaryJudgment(language: ContentLanguage, number: number | undefined, name: string): string {
  if (language === 'en' && number && hexagramJudgmentEnglish[number]) return hexagramJudgmentEnglish[number];
  if (language === 'zh-CN' && number) return `\u7b2c${number}\u5366\u7684\u4e3b\u65e8\u9700\u7ed3\u5408\u672c\u5366\u3001\u52a8\u723b\u548c\u53d8\u5366\u5224\u65ad\uff0c\u4e0d\u80fd\u53ea\u770b\u4e00\u4e2a\u597d\u574f\u3002`;
  return `${name} sets the main theme; read it together with the moving line and changed pattern.`;
}

function movingLineJudgment(language: ContentLanguage, line: number): string {
  if (language === 'en') return movingLineJudgmentEnglish[line] ?? movingLineJudgmentEnglish[1];
  if (language === 'zh-CN') return `\u7b2c${line}\u723b\u662f\u672c\u6b21\u53d8\u5316\u7684\u5173\u952e\uff0c\u5148\u6838\u5bf9\u8fd9\u4e00\u6b65\u7684\u5b9e\u9645\u53cd\u9988\u3002`;
  return `Moving line ${line} is the key change; verify the real response at this step.`;
}

export function formatHexagramDisplayName(number: number | undefined, fallbackName: string, language: ContentLanguage): string {
  if (language === 'zh-CN') return number ? `第${number}卦 · ${fallbackName}` : fallbackName;
  if (!number) return fallbackName;
  const prefix: Record<Exclude<ContentLanguage, 'zh-CN'>, string> = {
    en: 'Hexagram', es: 'Hexagrama', fr: 'Hexagramme', de: 'Hexagramm',
    ja: 'Hexagram', ko: 'Hexagram', pt: 'Hexagrama', ru: 'Гексаграмма',
  };
  return `${prefix[language]} ${number} · ${hexagramEnglish[number] ?? fallbackName}`;
}

type RelationKind = 'support' | 'invest' | 'control' | 'resist' | 'balance';
function relationKind(result: MeihuaResult): RelationKind {
  const value = result.relations?.[0] ?? '';
  if (value.startsWith('用生体')) return 'support';
  if (value.startsWith('体生用')) return 'invest';
  if (value.startsWith('体克用')) return 'control';
  if (value.startsWith('用克体')) return 'resist';
  return 'balance';
}

/** Layer-2 direction of the 体用 relationship, derived purely from rules. */
export type ConclusionDirection = 'FAVORABLE' | 'CAUTION' | 'INVEST' | 'CONTROLLABLE' | 'BALANCED';

/** Layer-2 timing bucket, derived purely from the moving line position. */
export type ConclusionTiming = 'EARLY' | 'LATER';

/**
 * Layer-2 structured conclusion: the complete, deterministic rule output that
 * the speech layer (Layer 3) is allowed to verbalize — and nothing more. It is
 * derived from the cast facts + question category by fixed rule tables; the
 * LLM never sees the raw result, so it cannot drift from it.
 */
export interface MeihuaConclusion {
  schemaVersion: 1;
  hexagram: {
    primary: { name: string; number?: number };
    mutual?: { name: string; number?: number };
    changed?: { name: string; number?: number };
    movingLine: number;
  };
  tiYong: {
    body: string;
    use: string;
    relation: RelationKind;
    direction: ConclusionDirection;
  };
  timing: ConclusionTiming;
  category?: ModerationResult['category'];
  /** Primary hexagram judgment and moving-line consequence used verbatim by the speech layer. */
  primaryJudgment: string;
  movingLineJudgment: string;
  changedJudgment?: string;
  /** Fixed, language-localized judgment points (断语要点) for this cast. */
  judgmentPoints: string[];
  /** Fixed structural facts (卦名/动爻/体用) this conclusion rests on. */
  facts: string[];
}

type DirectionCopy = Record<ConclusionDirection, { label: string; sentence: string }>;
type CategoryCopy = Partial<Record<ModerationResult['category'], string>>;
type TimingCopy = { early: string; later: string };

const directionCopy: Record<ContentLanguage, DirectionCopy> = {
  en: {
    FAVORABLE: { label: 'Favorable', sentence: 'External conditions are working with you.' },
    CAUTION: { label: 'Caution', sentence: 'External resistance is stronger, so steady first.' },
    INVEST: { label: 'Effort', sentence: 'The load is mostly yours, so pace your energy.' },
    CONTROLLABLE: { label: 'Controllable', sentence: 'You have room to lead this and set the next step.' },
    BALANCED: { label: 'Balanced', sentence: 'Your inner and outer conditions are aligned.' },
  },
  'zh-CN': {
    FAVORABLE: { label: '顺势', sentence: '外部条件对自身形成助力。' },
    CAUTION: { label: '谨慎', sentence: '外部阻力较强，宜先稳后动。' },
    INVEST: { label: '投入', sentence: '自身投入较多，宜控制消耗。' },
    CONTROLLABLE: { label: '可控', sentence: '自身有主动掌控空间。' },
    BALANCED: { label: '平稳', sentence: '内外条件整体相互呼应。' },
  },
  es: {
    FAVORABLE: { label: 'Favorable', sentence: 'Las condiciones externas juegan a tu favor.' },
    CAUTION: { label: 'Cautela', sentence: 'La resistencia externa es mayor; estabiliza primero.' },
    INVEST: { label: 'Esfuerzo', sentence: 'La mayor parte del trabajo es tuyo; cuida tu energía.' },
    CONTROLLABLE: { label: 'Controlable', sentence: 'Tienes espacio para dirigir y marcar el siguiente paso.' },
    BALANCED: { label: 'Equilibrado', sentence: 'Tus condiciones internas y externas están alineadas.' },
  },
  fr: { FAVORABLE: { label: 'Favorable', sentence: 'Les conditions externes jouent en votre faveur.' }, CAUTION: { label: 'Prudence', sentence: 'La résistance extérieure est forte ; stabilisez d’abord.' }, INVEST: { label: 'Effort', sentence: 'L’essentiel du travail est de votre côté ; ménagez votre énergie.' }, CONTROLLABLE: { label: 'Contrôlable', sentence: 'Vous avez la place de diriger et de poser la prochaine étape.' }, BALANCED: { label: 'Équilibré', sentence: 'Vos conditions intérieures et extérieures sont alignées.' } },
  de: { FAVORABLE: { label: 'Günstig', sentence: 'Die äußeren Bedingungen wirken für dich.' }, CAUTION: { label: 'Vorsicht', sentence: 'Der äußere Widerstand ist stärker – erst stabilisieren.' }, INVEST: { label: 'Einsatz', sentence: 'Der größte Teil der Arbeit liegt bei dir; steuere deine Energie.' }, CONTROLLABLE: { label: 'Steuerbar', sentence: 'Du hast Raum, dies zu führen und den nächsten Schritt zu setzen.' }, BALANCED: { label: 'Ausgeglichen', sentence: 'Deine inneren und äußeren Bedingungen sind im Einklang.' } },
  ja: { FAVORABLE: { label: '順調', sentence: '外部条件はあなたを支えています。' }, CAUTION: { label: '慎重', sentence: '外部の抵抗が強いため、まず安定を優先してください。' }, INVEST: { label: '投入', sentence: '自分の負担が大きいため、エネルギー配分が重要です。' }, CONTROLLABLE: { label: '主導', sentence: '主体的に次の一歩を選べる余地があります。' }, BALANCED: { label: '均衡', sentence: '内外の条件はおおむね調和しています。' } },
  ko: { FAVORABLE: { label: '순조', sentence: '외부 조건이 당신을 돕고 있습니다.' }, CAUTION: { label: '신중', sentence: '외부 저항이 강하므로 먼저 안정시키세요.' }, INVEST: { label: '투입', sentence: '자신의 투입이 크므로 에너지를 관리하세요.' }, CONTROLLABLE: { label: '주도', sentence: '주도적으로 다음 단계를 정할 여지가 있습니다.' }, BALANCED: { label: '균형', sentence: '내부와 외부 조건이 대체로 조화를 이룹니다.' } },
  pt: { FAVORABLE: { label: 'Favorável', sentence: 'As condições externas estão a seu favor.' }, CAUTION: { label: 'Cautela', sentence: 'A resistência externa é maior; estabilize primeiro.' }, INVEST: { label: 'Esforço', sentence: 'A maior parte do trabalho é sua; administre a energia.' }, CONTROLLABLE: { label: 'Controlável', sentence: 'Você tem espaço para conduzir e dar o próximo passo.' }, BALANCED: { label: 'Equilibrado', sentence: 'Suas condições internas e externas estão alinhadas.' } },
  ru: { FAVORABLE: { label: 'Благоприятно', sentence: 'Внешние условия на вашей стороне.' }, CAUTION: { label: 'Осторожно', sentence: 'Внешнее сопротивление сильнее — сначала стабилизируйте.' }, INVEST: { label: 'Усилия', sentence: 'Основная нагрузка на вас; берегите энергию.' }, CONTROLLABLE: { label: 'Управляемо', sentence: 'У вас есть пространство вести и задавать следующий шаг.' }, BALANCED: { label: 'Сбалансировано', sentence: 'Внешние и внутренние условия согласованы.' } },
};

const categoryPoint: Record<ContentLanguage, CategoryCopy> = {
  en: {
    CAREER: 'For work and plans, the pattern favors pacing real results over quick promises.',
    RELATIONSHIP: 'For people and bonds, honest and unhurried contact beats forcing the talk.',
    STUDY: 'For learning, small consistent practice is what the pattern supports.',
    LIFE: 'For daily life, one clear decision at a time keeps things steady.',
    FINANCE_GENERAL: 'For money moves, keep them small and checkable until the trend steadies.',
    OTHER: 'Keep the goal plain and the steps verifiable.',
    RISK: 'With risk involved, stay small, stay slow, and confirm every step.',
  },
  'zh-CN': {
    CAREER: '关于事业与计划，先落一个可验证的小步骤，比急着下结论更稳。',
    RELATIONSHIP: '关于感情与沟通，坦诚而从容的接触比强行摊牌更顺。',
    STUDY: '关于学业，持续的小练习是卦象支持的路径。',
    LIFE: '关于日常生活，一次一个清晰的决策就能稳住节奏。',
    FINANCE_GENERAL: '关于钱财，保持小额、可检查，等趋势稳住再加码。',
    OTHER: '把目标放简单，把步骤做可验证。',
    RISK: '涉及风险时，步子要小、要慢，每一步都确认。',
  },
  es: {
    CAREER: 'Para trabajo y planes, el patrón favorece resultados comprobables antes que promesas rápidas.',
    RELATIONSHIP: 'Para personas y vínculos, el contacto honesto y sin prisa gana a forzar la conversación.',
    STUDY: 'Para el estudio, la práctica constante y pequeña es lo que sostiene el patrón.',
    LIFE: 'Para la vida diaria, una decisión clara a la vez mantiene el ritmo.',
    FINANCE_GENERAL: 'Para el dinero, mantén montos pequeños y verificables hasta que la tendencia se asiente.',
    OTHER: 'Mantén la meta simple y los pasos verificables.',
    RISK: 'Con riesgo de por medio, pasos pequeños y lentos, confirmando cada uno.',
  },
  fr: { CAREER: 'Pour le travail, le motif favorise des résultats vérifiables avant les promesses rapides.', RELATIONSHIP: 'Pour les liens, un contact honnête et sans hâte vaut mieux que forcer la discussion.', STUDY: 'Pour l’étude, une pratique régulière et modeste soutient le motif.', LIFE: 'Pour le quotidien, une décision claire à la fois garde le rythme.', FINANCE_GENERAL: 'Pour l’argent, des montants petits et vérifiables jusqu’à ce que la tendance se stabilise.', OTHER: 'Gardez le but simple et les étapes vérifiables.', RISK: 'Avec du risque, restez petit, lent, et confirmez chaque étape.' },
  de: { CAREER: 'Bei Arbeit und Plänen begünstigt das Muster nachprüfbare Ergebnisse vor schnellen Versprechen.', RELATIONSHIP: 'Bei Menschen und Bindungen gewinnt ehrlicher, ruhiger Kontakt vor erzwungenen Gesprächen.', STUDY: 'Beim Lernen trägt kleine, stetige Übung das Muster.', LIFE: 'Im Alltag hält eine klare Entscheidung nach der anderen den Rhythmus.', FINANCE_GENERAL: 'Bei Geld bleib klein und nachprüfbar, bis sich der Trend festigt.', OTHER: 'Halte das Ziel einfach und die Schritte nachprüfbar.', RISK: 'Bei Risiko: klein bleiben, langsam bleiben, jeden Schritt bestätigen.' },
  ja: { CAREER: '仕事や計画では、速い約束より検証できる成果を優先するのがこの卦の示しです。', RELATIONSHIP: '人との関係では、無理に話を進めるより誠実で落ち着いた接し方が勝ります。', STUDY: '学びでは、小さな継続練習が卦の支える道です。', LIFE: '暮らしでは、一度に一つの明確な決断がリズムを保ちます。', FINANCE_GENERAL: 'お金の動きは、傾向が落ち着くまで小さく確認できる範囲で。', OTHER: '目標をシンプルに、手順を検証可能に。', RISK: 'リスクが絡む時は、小さく、ゆっくり、一歩ごとに確認。' },
  ko: { CAREER: '일과 계획은 빠른 약속보다 검증 가능한 결과를 우선하는 것이 좋습니다.', RELATIONSHIP: '사람과 관계는 억지로 대화를 몰아가기보다 정직하고 여유 있는 접촉이 낫습니다.', STUDY: '학업에서는 작고 꾸준한 연습이 괘가 지지하는 길입니다.', LIFE: '일상에서는 한 번에 하나의 분명한 결정이 리듬을 유지합니다.', FINANCE_GENERAL: '돈은 추세가 안정될 때까지 작고 확인 가능한 범위로.', OTHER: '목표를 단순하게, 단계는 검증 가능하게.', RISK: '위험이 따르면 작게, 천천히, 매 단계 확인하며.' },
  pt: { CAREER: 'Para trabalho e planos, o padrão favorece resultados verificáveis antes de promessas rápidas.', RELATIONSHIP: 'Para pessoas e vínculos, contato honesto e sem pressa vence forçar a conversa.', STUDY: 'Para o estudo, prática pequena e constante é o que o padrão sustenta.', LIFE: 'Para o dia a dia, uma decisão clara de cada vez mantém o ritmo.', FINANCE_GENERAL: 'Para dinheiro, mantenha valores pequenos e verificáveis até a tendência assentar.', OTHER: 'Mantenha a meta simples e os passos verificáveis.', RISK: 'Com risco, fique pequeno, lento, e confirme cada passo.' },
  ru: { CAREER: 'Для работы и планов паттерн отдаёт предпочтение проверяемым результатам, а не быстрым обещаниям.', RELATIONSHIP: 'В отношениях честный и неторопливый контакт лучше, чем навязанный разговор.', STUDY: 'В учёбе постоянная небольшая практика — путь, который поддерживает паттерн.', LIFE: 'В быту одна ясная решимость за раз держит ритм.', FINANCE_GENERAL: 'С деньгами держитесь малых и проверяемых сумм, пока тренд не устоится.', OTHER: 'Держите цель простой, а шаги проверяемыми.', RISK: 'С риском — меньше, медленнее, каждый шаг подтверждать.' },
};

const timingCopy: Record<ContentLanguage, TimingCopy> = {
  en: { early: 'The shift starts close to home, with foundations and prep work.', later: 'The shift will likely show up through outside events and later on.' },
  'zh-CN': { early: '变化先从内部与基础层面展开。', later: '变化更多显现在外部与后续阶段。' },
  es: { early: 'El cambio empieza en la base y la preparación interna.', later: 'El cambio se verá más en eventos externos y etapas posteriores.' },
  fr: { early: 'Le changement commence par les fondations et la préparation.', later: 'Le changement se verra surtout dans les événements extérieurs.' },
  de: { early: 'Die Veränderung beginnt bei den Grundlagen und der Vorbereitung.', later: 'Die Veränderung zeigt sich eher in äußeren Ereignissen und späteren Phasen.' },
  ja: { early: '変化は基盤と内側の準備から始まります。', later: '変化は外部の出来事や後半に現れやすいでしょう。' },
  ko: { early: '변화는 기반과 내부 준비에서 시작됩니다.', later: '변화는 외부 사건과 후반 단계에서 더 잘 드러납니다.' },
  pt: { early: 'A mudança começa nas bases e na preparação interna.', later: 'A mudança tende a aparecer em eventos externos e etapas posteriores.' },
  ru: { early: 'Изменение начинается с основы и внутренней подготовки.', later: 'Изменение проявится во внешних событиях и на более поздних этапах.' },
};

/**
 * Deterministic Layer-2 conclusion builder. Everything here comes from fixed
 * rule tables over the cast facts and the optional question category; no
 * language model is involved and no content can drift between reads.
 */
export function concludeReading(input: { result: MeihuaResult; language?: ContentLanguage; category?: ModerationResult['category'] }): MeihuaConclusion {
  const language = input.language ?? 'en';
  const moving = input.result.movingLines[0] ?? 1;
  const kind = relationKind(input.result);
  const direction: ConclusionDirection = kind === 'support' ? 'FAVORABLE' : kind === 'resist' ? 'CAUTION' : kind === 'invest' ? 'INVEST' : kind === 'control' ? 'CONTROLLABLE' : 'BALANCED';
  const timing: ConclusionTiming = moving <= 3 ? 'EARLY' : 'LATER';
  const facts = [
    `${input.result.primary.name} (${input.result.primary.number ?? '?'})`,
    input.result.changed ? `${input.result.changed.name} (${input.result.changed.number ?? '?'})` : '',
    input.result.mutual ? `${input.result.mutual.name} (${input.result.mutual.number ?? '?'})` : '',
    `Moving line ${moving}`,
  ].filter(Boolean);
  const points: string[] = [];
  points.push(directionCopy[language][direction].sentence);
  const category = input.category && categoryPoint[language][input.category] ? categoryPoint[language][input.category] : undefined;
  if (category) points.push(category);
  points.push(timingCopy[language][timing === 'EARLY' ? 'early' : 'later']);
  const primaryNumber = input.result.primary.number;
  const changedNumber = input.result.changed?.number;
  const primary = primaryJudgment(language, primaryNumber, input.result.primary.name);
  const movingLine = movingLineJudgment(language, moving);
  const changed = changedNumber && changedNumber !== primaryNumber
    ? primaryJudgment(language, changedNumber, input.result.changed?.name ?? `Hexagram ${changedNumber}`)
    : undefined;
  return {
    schemaVersion: 1,
    hexagram: {
      primary: { name: input.result.primary.name, number: input.result.primary.number },
      mutual: input.result.mutual ? { name: input.result.mutual.name, number: input.result.mutual.number } : undefined,
      changed: input.result.changed ? { name: input.result.changed.name, number: input.result.changed.number } : undefined,
      movingLine: moving,
    },
    tiYong: { body: input.result.bodyTrigram ?? '', use: input.result.useTrigram ?? '', relation: kind, direction },
    timing,
    category: category ? input.category : undefined,
    primaryJudgment: primary,
    movingLineJudgment: movingLine,
    changedJudgment: changed,
    judgmentPoints: points,
    facts,
  };
}

type Copy = {
  opening: (name:string)=>string; intro:(q:string,h:string,line:number,c:string)=>string;
  relations:Record<RelationKind,string>; timing:(line:number)=>string; action:string; conditions:string; review:string;
  closing:string; line:(line:number)=>string; keywords:Record<RelationKind,string>;
};

const copies: Record<ContentLanguage, Copy> = {
  // English is written for natural spoken US TikTok delivery: short, warm and
  // entertaining, while every sentence stays traceable to the structured
  // hexagram facts (primary/mutual/changed names, moving line, 体用 relation).
  en:{opening:n=>`Hey ${n}, let us look at this. `,intro:(q,h,l,c)=>`So your question is “${q}.” Our hexagram came up as ${h}, with line ${l} moving into ${c}. `,relations:{support:'The energy around you is on your side.',invest:'This one rides mostly on your own effort.',control:'You can take the lead here.',resist:'There is pushback, so steady yourself first.',balance:'Your inside and outside line up evenly.'},timing:l=>l<=3?'The shift starts close to home, with your foundations and prep work. ':'The shift will likely show up through outside events and later on. ',action:'Turn it into one tiny step you can test, watch what happens, then decide if you want to go bigger. ',conditions:'If things keep flipping, check that your resources, communication, and timing really line up before you lock anything in. ',review:'Set one clear check-in point and judge it by real progress, real cost, and how you actually feel at that moment. ',closing:'This is a traditional cultural reading for fun and reflection — never a promise.',line:l=>`Line ${l}`,keywords:{support:'Support',invest:'Pace your energy',control:'Take the lead',resist:'Steady first',balance:'Alignment'}},
  'zh-CN':{opening:n=>`${n}，我们来看这一轮。`,intro:(q,h,l,c)=>`关于“${q}”，本卦为${h}，第${l}爻动，变为${c}。`,relations:{support:'外部条件对自身形成助力。',invest:'自身投入较多，宜控制消耗。',control:'自身有主动掌控空间。',resist:'外部阻力较强，宜先稳后动。',balance:'内外条件整体相互呼应。'},timing:l=>l<=3?'变化先从内部与基础层面展开。':'变化更多显现在外部与后续阶段。',action:'先把目标拆成一个可验证的小步骤，观察现实反馈，再决定是否继续加码。',conditions:'如果条件反复，先确认资源、沟通和时间是否真正匹配，不必急于定局。',review:'给自己设一个明确的复盘节点，只看事实进展、成本和实际感受。',closing:'以上是传统文化角度的互动解读，仅作娱乐与交流参考。',line:l=>`第${l}爻动`,keywords:{support:'外部助力',invest:'控制投入',control:'主动推进',resist:'先稳后动',balance:'体用协调'}},
  es:{opening:n=>`${n}, veamos esta lectura. `,intro:(q,h,l,c)=>`Para “${q}”, el hexagrama principal es ${h}. La línea ${l} cambia hacia ${c}. `,relations:{support:'Las condiciones externas ofrecen apoyo.',invest:'Tu esfuerzo sostiene más carga; administra tu energía.',control:'Tienes margen para tomar la iniciativa.',resist:'La resistencia externa es fuerte; estabiliza primero.',balance:'Las condiciones internas y externas están alineadas.'},timing:l=>l<=3?'El cambio empieza en la base y la preparación interna. ':'El cambio aparecerá más en eventos externos y etapas posteriores. ',action:'Convierte la meta en un paso pequeño y comprobable antes de comprometer más recursos. ',conditions:'Si las condiciones cambian, revisa recursos, comunicación y tiempo sin forzar una conclusión. ',review:'Fija una fecha de revisión y evalúa progreso, coste y resultado real. ',closing:'Lectura cultural tradicional solo para entretenimiento y reflexión.',line:l=>`Línea ${l}`,keywords:{support:'Apoyo',invest:'Cuidar energía',control:'Iniciativa',resist:'Estabilizar',balance:'Alineación'}},
  fr:{opening:n=>`${n}, regardons ce tirage. `,intro:(q,h,l,c)=>`Pour « ${q} », l’hexagramme principal est ${h}. La ligne ${l} évolue vers ${c}. `,relations:{support:'Les conditions extérieures vous soutiennent.',invest:'Votre effort porte davantage; préservez votre énergie.',control:'Vous pouvez prendre l’initiative.',resist:'La résistance extérieure est forte; stabilisez d’abord.',balance:'Les conditions intérieures et extérieures sont alignées.'},timing:l=>l<=3?'Le changement commence par les fondations et la préparation. ':'Le changement apparaîtra surtout dans les événements extérieurs. ',action:'Transformez l’objectif en une petite étape vérifiable avant d’engager davantage. ',conditions:'Si les conditions bougent, vérifiez ressources, communication et calendrier. ',review:'Fixez un point de bilan et jugez les progrès, le coût et le résultat réel. ',closing:'Lecture culturelle traditionnelle, uniquement pour le divertissement et la réflexion.',line:l=>`Ligne ${l}`,keywords:{support:'Soutien',invest:'Préserver l’énergie',control:'Initiative',resist:'Stabiliser',balance:'Alignement'}},
  de:{opening:n=>`${n}, sehen wir uns diese Deutung an. `,intro:(q,h,l,c)=>`Zu „${q}“ lautet das Haupthexagramm ${h}. Linie ${l} wandelt sich zu ${c}. `,relations:{support:'Die äußeren Bedingungen wirken unterstützend.',invest:'Ihr eigener Einsatz trägt mehr; schonen Sie Ihre Energie.',control:'Sie haben Spielraum, die Initiative zu ergreifen.',resist:'Der äußere Widerstand ist stärker; zuerst stabilisieren.',balance:'Innere und äußere Bedingungen sind weitgehend im Einklang.'},timing:l=>l<=3?'Die Veränderung beginnt bei Grundlagen und Vorbereitung. ':'Die Veränderung zeigt sich eher in äußeren Ereignissen und späteren Phasen. ',action:'Machen Sie aus dem Ziel einen kleinen, überprüfbaren Schritt, bevor Sie mehr einsetzen. ',conditions:'Bei wechselnden Bedingungen prüfen Sie Ressourcen, Kommunikation und Timing. ',review:'Setzen Sie einen klaren Prüfzeitpunkt und bewerten Sie Fortschritt, Kosten und Ergebnis. ',closing:'Traditionelle kulturelle Deutung, nur zur Unterhaltung und Reflexion.',line:l=>`Linie ${l}`,keywords:{support:'Unterstützung',invest:'Energie steuern',control:'Initiative',resist:'Stabilisieren',balance:'Ausrichtung'}},
  ja:{opening:n=>`${n}さん、このリーディングを見ていきましょう。`,intro:(q,h,l,c)=>`「${q}」について、本卦は${h}です。第${l}爻が動き、${c}へ変化します。`,relations:{support:'外部条件が支えになっています。',invest:'自分の負担が大きいため、エネルギー配分が重要です。',control:'主体的に次の一歩を選べる余地があります。',resist:'外部の抵抗が強いため、まず安定を優先してください。',balance:'内外の条件はおおむね調和しています。'},timing:l=>l<=3?'変化は基盤と内側の準備から始まります。':'変化は外部の出来事や後半の段階に現れやすいでしょう。',action:'目標を小さく検証できる一歩に分け、現実の反応を見てから投入を増やしましょう。',conditions:'状況が揺れる時は、資源・対話・タイミングが合っているか確認してください。',review:'明確な見直し時点を決め、進捗・コスト・実際の結果で判断しましょう。',closing:'伝統文化によるエンターテインメントと振り返りのための内容です。',line:l=>`第${l}爻`,keywords:{support:'支援',invest:'消耗管理',control:'主体性',resist:'安定優先',balance:'調和'}},
  ko:{opening:n=>`${n}님, 이번 리딩을 살펴보겠습니다. `,intro:(q,h,l,c)=>`“${q}”에 대한 본괘는 ${h}입니다. ${l}효가 움직여 ${c}로 변합니다. `,relations:{support:'외부 조건이 도움을 주고 있습니다.',invest:'자신의 투입이 크므로 에너지를 관리하세요.',control:'주도적으로 다음 단계를 정할 여지가 있습니다.',resist:'외부 저항이 강하므로 먼저 안정시키세요.',balance:'내부와 외부 조건이 대체로 조화를 이룹니다.'},timing:l=>l<=3?'변화는 기반과 내부 준비에서 시작됩니다. ':'변화는 외부 사건과 후반 단계에서 더 잘 드러납니다. ',action:'목표를 검증 가능한 작은 단계로 나누고 실제 반응을 본 뒤 투입을 늘리세요. ',conditions:'조건이 흔들리면 자원, 소통, 시기가 맞는지 확인하세요. ',review:'명확한 검토 시점을 정하고 진행, 비용, 실제 결과로 판단하세요. ',closing:'전통문화 기반의 오락 및 성찰용 콘텐츠입니다.',line:l=>`${l}효 변동`,keywords:{support:'지원',invest:'에너지 관리',control:'주도성',resist:'안정 우선',balance:'조화'}},
  pt:{opening:n=>`${n}, vamos ver esta leitura. `,intro:(q,h,l,c)=>`Para “${q}”, o hexagrama principal é ${h}. A linha ${l} muda para ${c}. `,relations:{support:'As condições externas estão favoráveis.',invest:'Seu esforço está maior; administre sua energia.',control:'Você tem espaço para tomar a iniciativa.',resist:'A resistência externa é forte; estabilize primeiro.',balance:'As condições internas e externas estão alinhadas.'},timing:l=>l<=3?'A mudança começa nas bases e na preparação interna. ':'A mudança tende a aparecer em eventos externos e etapas posteriores. ',action:'Transforme o objetivo em um pequeno passo verificável antes de ampliar o compromisso. ',conditions:'Se as condições oscilarem, verifique recursos, comunicação e tempo. ',review:'Defina um ponto de revisão e avalie progresso, custo e resultado real. ',closing:'Leitura cultural tradicional apenas para entretenimento e reflexão.',line:l=>`Linha ${l}`,keywords:{support:'Apoio',invest:'Gerir energia',control:'Iniciativa',resist:'Estabilizar',balance:'Alinhamento'}},
  ru:{opening:n=>`${n}, рассмотрим это чтение. `,intro:(q,h,l,c)=>`Для вопроса «${q}» основной знак — ${h}. Линия ${l} меняется в ${c}. `,relations:{support:'Внешние условия оказывают поддержку.',invest:'Ваша нагрузка выше; берегите энергию.',control:'У вас есть пространство для инициативы.',resist:'Внешнее сопротивление сильнее; сначала стабилизируйте ситуацию.',balance:'Внутренние и внешние условия в целом согласованы.'},timing:l=>l<=3?'Изменение начинается с основы и внутренней подготовки. ':'Изменение проявится во внешних событиях и более поздних этапах. ',action:'Разбейте цель на небольшой проверяемый шаг и только после обратной связи увеличивайте вложения. ',conditions:'При нестабильности проверьте ресурсы, коммуникацию и сроки. ',review:'Назначьте точку пересмотра и оцените прогресс, стоимость и реальный результат. ',closing:'Традиционное культурное чтение только для развлечения и размышления.',line:l=>`Линия ${l}`,keywords:{support:'Поддержка',invest:'Беречь энергию',control:'Инициатива',resist:'Стабилизация',balance:'Согласованность'}},
};

const shortClosings: Record<ContentLanguage, string> = {
  en: 'Just for reflection.',
  'zh-CN': '仅作传统文化交流参考。',
  es: 'Solo para reflexión.',
  fr: 'Pour réflexion uniquement.',
  de: 'Nur zur Reflexion.',
  ja: '文化的な参考としてのみ。',
  ko: '문화적 참고용입니다.',
  pt: 'Apenas para reflexão.',
  ru: 'Только для размышления.',
};

function compactHexagramIntro(language: ContentLanguage, primary: string, moving: number, changed: string, question?: string): string {
  // The 28–46s tiers echo the viewer's own question back into the read; the
  // tiers above and below stay compact so the fixed skeleton keeps fit checks.
  const echo = question && question.trim() ? question.trim().slice(0, 60) : undefined;
  switch (language) {
    case 'zh-CN': return echo ? `关于“${echo}”，本卦为${primary}，第${moving}爻动，变为${changed}。` : `${primary}，第${moving}爻动，变为${changed}。`;
    case 'es': return echo ? `Para “${echo}”, ${primary}; la línea ${moving} cambia a ${changed}.` : `${primary}; la línea ${moving} cambia a ${changed}.`;
    case 'fr': return echo ? `Pour « ${echo} », ${primary} ; la ligne ${moving} évolue vers ${changed}.` : `${primary} ; la ligne ${moving} évolue vers ${changed}.`;
    case 'de': return echo ? `Zu „${echo}“: ${primary}; Linie ${moving} wandelt sich zu ${changed}.` : `${primary}; Linie ${moving} wandelt sich zu ${changed}.`;
    case 'ja': return echo ? `「${echo}」について、${primary}。第${moving}爻が動き、${changed}へ変化します。` : `${primary}。第${moving}爻が動き、${changed}へ変化します。`;
    case 'ko': return echo ? `“${echo}”의 ${primary}. ${moving}효가 움직여 ${changed}(으)로 변합니다.` : `${primary}. ${moving}효가 움직여 ${changed}(으)로 변합니다.`;
    case 'pt': return echo ? `Para “${echo}”, ${primary}; a linha ${moving} muda para ${changed}.` : `${primary}; a linha ${moving} muda para ${changed}.`;
    case 'ru': return echo ? `По вопросу «${echo}»: ${primary}; линия ${moving} меняется в ${changed}.` : `${primary}; линия ${moving} меняется в ${changed}.`;
    default: return echo ? `So your question is “${echo}.” ${primary}. Line ${moving} changes to ${changed}.` : `${primary}. Line ${moving} changes to ${changed}.`;
  }
}

const lengthFillers: Record<ContentLanguage, string[]> = {
  en: [
    'Keep the pace steady, check the response, and adjust one step at a time.',
    'Let the next decision follow what is actually happening, not a rushed assumption.',
  ],
  'zh-CN': [
    '接下来先稳住节奏，观察实际反馈，再一步一步调整。',
    '后续判断以真实变化为准，不要因为一时着急而提前下结论。',
  ],
  es: [
    'Mantén un ritmo estable, observa la respuesta y ajusta un paso a la vez.',
    'Deja que la siguiente decisión se base en lo que ocurre, no en una suposición apresurada.',
  ],
  fr: [
    'Gardez un rythme stable, observez la réponse et ajustez une étape à la fois.',
    'Que la prochaine décision parte de ce qui se passe réellement, sans conclure trop vite.',
  ],
  de: [
    'Bleiben Sie ruhig, prüfen Sie die Reaktion und passen Sie den nächsten Schritt an.',
    'Die nächste Entscheidung sollte auf dem tatsächlichen Verlauf beruhen, nicht auf Eile.',
  ],
  ja: [
    'まずは流れを落ち着いて見守り、反応を確かめながら一歩ずつ調整しましょう。',
    '急いで決めつけず、実際の変化を見て次の判断につなげてください。',
  ],
  ko: [
    '흐름을 차분히 지켜보고 반응을 확인하면서 한 단계씩 조정하세요.',
    '서둘러 단정하지 말고 실제 변화를 본 뒤 다음 결정을 정하세요.',
  ],
  pt: [
    'Mantenha um ritmo estável, observe a resposta e ajuste um passo de cada vez.',
    'Deixe a próxima decisão seguir o que realmente acontece, sem concluir com pressa.',
  ],
  ru: [
    'Сохраняйте спокойный темп, наблюдайте за реакцией и меняйте только один шаг за раз.',
    'Следующее решение лучше принимать по реальным изменениям, а не в спешке.',
  ],
};

const shortLengthFillers: Record<ContentLanguage, string> = {
  en: 'Stay steady.',
  'zh-CN': '先稳住。',
  es: 'Mantén la calma.',
  fr: 'Restez calme.',
  de: 'Bleiben Sie ruhig.',
  ja: '落ち着いて。',
  ko: '차분히 보세요.',
  pt: 'Siga com calma.',
  ru: 'Сохраняйте спокойствие.',
};

// Short, decision-oriented units used only when a duration boundary leaves
// the deterministic result one or two units below the lower limit. These are
// advice, not greetings or disclaimers, so the direct-delivery contract stays
// intact.
const directMicroAdvice: Record<ContentLanguage, string> = {
  en: 'Steady.',
  'zh-CN': '先稳住。',
  es: 'Ve con calma.',
  fr: 'Restez stable.',
  de: 'Bleib ruhig.',
  ja: '落ち着いて。',
  ko: '차분히 가세요.',
  pt: 'Siga com calma.',
  ru: 'Сохраняйте спокойствие.',
};

// A longer tier may need one more decision-relevant sentence after the fixed
// result, direction, timing, action and conditions have been stated. These
// are still conclusions from the cast, not greetings or generic padding.
const directExpansionCopy: Partial<Record<ContentLanguage, string[]>> = {
  en: [
    'Use the primary judgment as the decision rule, not as a promise of an automatic result.',
    'The changed pattern describes where the situation is heading if the present behavior continues.',
    'The moving line is the first checkpoint: test that specific step before committing more resources.',
    'If the facts support the reading, continue; if they do not, correct the method rather than forcing the answer.',
    'Keep the conclusion tied to this question, this cast, and the evidence that appears next.',
    'The useful result is a clear next action with a boundary, a time to review, and a condition for stopping.',
    'Do not let a favorable sign replace preparation, and do not let a warning become unnecessary fear.',
    'Read the change as direction and timing, then let the real response decide how far to go.',
  ],
  'zh-CN': [
    '\u4ee5\u672c\u5366\u4e3b\u65e8\u4f5c\u4e3a\u5224\u65ad\u6807\u51c6\uff0c\u4e0d\u628a\u5366\u8c61\u5f53\u6210\u81ea\u52a8\u4fdd\u8bc1\u3002',
    '\u53d8\u5366\u8868\u793a\u5982\u679c\u5ef6\u7eed\u5f53\u524d\u505a\u6cd5\uff0c\u4e8b\u60c5\u4f1a\u5411\u54ea\u91cc\u8d70\u3002',
    '\u52a8\u723b\u662f\u7b2c\u4e00\u4e2a\u68c0\u67e5\u70b9\uff0c\u5148\u9a8c\u8bc1\u8fd9\u4e00\u6b65\u518d\u52a0\u5927\u6295\u5165\u3002',
    '\u4e8b\u5b9e\u7b26\u5408\u65f6\u5c31\u7ee7\u7eed\uff0c\u4e0d\u7b26\u5408\u5c31\u4fee\u6b63\u65b9\u6cd5\uff0c\u4e0d\u8981\u786c\u5957\u7ed3\u8bba\u3002',
    '\u8fd9\u6b21\u5224\u65ad\u53ea\u5bf9\u5e94\u5f53\u524d\u95ee\u9898\u3001\u5f53\u524d\u5366\u548c\u63a5\u4e0b\u6765\u7684\u5b9e\u9645\u53cd\u9988\u3002',
    '\u6700\u6709\u7528\u7684\u7ed3\u679c\u662f\u4e00\u4e2a\u6709\u8fb9\u754c\u3001\u6709\u590d\u76d8\u65f6\u95f4\u7684\u660e\u786e\u4e0b\u4e00\u6b65\u3002',
    '\u987a\u52bf\u4e5f\u8981\u5148\u505a\u51c6\u5907\uff0c\u63d0\u9192\u4e5f\u4e0d\u7b49\u4e8e\u5fc5\u7136\u5931\u8d25\u3002',
    '\u5148\u770b\u53d8\u5316\u7684\u65b9\u5411\u548c\u65f6\u673a\uff0c\u518d\u7528\u771f\u5b9e\u53cd\u5e94\u51b3\u5b9a\u8d70\u591a\u8fdc\u3002',
  ],
};
const directBridgeCopy: Partial<Record<ContentLanguage, string>> = {
  en: 'Check the facts before you commit.',
  'zh-CN': '\u5148\u770b\u4e8b\u5b9e\u518d\u5b9a\u3002',
};

export class RuleBasedAnswerComposer implements AnswerComposer {
  async compose(input: AnswerComposerInput): Promise<AnswerContent> {
    const target = Math.max(10, Math.min(120, Math.round(input.targetSeconds ?? 28)));
    const language = input.language ?? 'en';
    const copy = copies[language];
    const moving = input.result.movingLines[0] ?? 1;
    const kind = relationKind(input.result);
    const conclusion = concludeReading({ result: input.result, language, category: input.category });
    const primaryNumber = input.result.primary.number ?? 0;
    const changedNumber = input.result.changed?.number ?? primaryNumber;
    const primary = formatHexagramDisplayName(primaryNumber, input.result.primary.name, language);
    const changed = formatHexagramDisplayName(changedNumber, input.result.changed?.name ?? input.result.primary.name, language);
    const lengthTarget = estimateSpeechLengthTarget(language, target, input.speechRate);
    // The spoken payload is deliberately result-first.  The queue already
    // displayed the viewer/question, so repeating it here only adds dead air
    // and makes the answer sound like a generic template.  The cast facts and
    // the fixed rule conclusion below are the complete source of truth.
    const compactIntro = compactHexagramIntro(language, primary, moving, changed);
    const compactRelation = `${copy.keywords[kind]}.`;
    const opening = '';
    const closing = '';
    const parts = [compactIntro];
    const canFit = (candidate: string) => countSpeechUnits(`${opening}${[...parts, candidate].join(' ')}${closing}`, language) <= lengthTarget.maximum;
    // Layer-2 judgment points, assembled by fixed rule gates; every sentence is
    // deterministic copy over the cast facts.
    const directionSentence = conclusion.judgmentPoints[0]!;
    const categorySentence = conclusion.judgmentPoints[1];
    const timingSentence = conclusion.judgmentPoints[conclusion.category ? 2 : 1];
    const addIfFits = (candidate: string | undefined): boolean => {
      if (!candidate || parts.includes(candidate) || !canFit(candidate)) return false;
      parts.push(candidate);
      return true;
    };
    addIfFits(conclusion.primaryJudgment);
    if (target >= 20 && !addIfFits(directionSentence)) addIfFits(compactRelation);
    if (target >= 28) addIfFits(categorySentence);
    if (target >= 30) {
      addIfFits(timingSentence);
      addIfFits(conclusion.movingLineJudgment);
      addIfFits(conclusion.changedJudgment);
      // Include the actual 体用 relationship once the longer tier has room;
      // it is a calculation fact and makes the direction auditable.
      addIfFits(compactRelation);
    }
    if (target >= 45) addIfFits(copy.action);
    if (target >= 60) addIfFits(copy.conditions);
    if (target >= 95) addIfFits(copy.review);
    // Fill the lower bound explicitly. This is what makes a 20/30/60-second
    // queue entitlement a hard content contract instead of a best-effort hint.
    const expansionPool = [
      shortLengthFillers[language], ...(directExpansionCopy[language] ?? []), directBridgeCopy[language], categorySentence, timingSentence, conclusion.movingLineJudgment, conclusion.changedJudgment, copy.action, copy.conditions, copy.review,
      ...lengthFillers[language],
    ];
    let fillerIndex = 0;
    // Fill toward the new 1.6x target, not merely the old lower bound. The
    // maximum is still enforced by addIfFits, so a short sentence can land
    // naturally just under the target without padding the result.
    while (countSpeechUnits(`${opening}${parts.join(language === 'zh-CN' ? '' : ' ')}${closing}`, language) < lengthTarget.target) {
      const candidate = expansionPool[fillerIndex % expansionPool.length];
      fillerIndex += 1;
      if (!addIfFits(candidate)) {
        if (fillerIndex > expansionPool.length * 3) break;
      }
    }
    if (countSpeechUnits(`${opening}${parts.join(language === 'zh-CN' ? '' : ' ')}${closing}`, language) < lengthTarget.minimum) {
      addIfFits(directMicroAdvice[language]);
    }
    const answer = {
      opening, speech: parts.join(language === 'zh-CN' ? '' : ' ').replace(/\s+/g, ' ').trim(),
      keywords: [primary, copy.line(moving), copy.keywords[kind]].slice(0, 3).map((keyword) => keyword.slice(0, 32)),
      closing, estimatedSeconds: target,
    };
    assertAnswerLengthTarget(answer, language, target, input.speechRate);
    return withAnswerLengthMetrics(answer, language, target, input.speechRate);
  }
}

/**
 * The live voice must start with the calculated result and contain no hidden
 * greeting, question echo, or disclaimer.  If a remote model returns a
 * padded response, the caller falls back to the same deterministic composer.
 */
function isDirectSpokenAnswer(answer: AnswerContent, input: AnswerComposerInput, language: ContentLanguage): boolean {
  if (answer.opening.trim() || answer.closing.trim()) return false;
  const primary = formatHexagramDisplayName(input.result.primary.number, input.result.primary.name, language);
  return answer.speech.trim().startsWith(primary);
}

export type OpenAICompatibleComposerOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

function chatCompletionsUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (!value) throw new Error('LLM_BASE_URL_REQUIRED');
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

function readJsonContent(content: unknown): unknown {
  if (typeof content === 'string') {
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  }
  if (Array.isArray(content)) {
    const text = content.map((item) => item && typeof item === 'object' && 'text' in item ? String(item.text) : '').join('');
    return JSON.parse(text);
  }
  throw new Error('LLM_RESPONSE_CONTENT_MISSING');
}

/**
 * OpenAI-compatible structured answer generation. The model only receives the
 * deterministic hexagram result and must return the same contract used by the
 * local composer, so OBS and the speech pipeline remain provider-independent.
 */
export class OpenAICompatibleAnswerComposer implements AnswerComposer {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAICompatibleComposerOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async compose(input: AnswerComposerInput): Promise<AnswerContent> {
    if (!this.options.apiKey.trim()) throw new Error('LLM_API_KEY_REQUIRED');
    if (!this.options.model.trim()) throw new Error('LLM_MODEL_REQUIRED');
    const targetSeconds = Math.max(10, Math.min(120, Math.round(input.targetSeconds ?? 28)));
    const language = input.language ?? 'en';
    const lengthTarget = estimateSpeechLengthTarget(language, targetSeconds, input.speechRate);
    const conclusion = concludeReading({ result: input.result, language, category: input.category });
    const response = await this.fetcher(chatCompletionsUrl(this.options.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.35,
        messages: [
          {
            role: 'system',
            content: [
              'You are the voice layer of a deterministic divination pipeline. The structured `conclusion` is the complete truth set produced by fixed rules.',
              'Hard rules:',
              '1. NEVER add, change, or invent hexagram names, moving lines, 体用 relations, outcomes, guaranteed results, past events, or medical/legal/financial advice. The conclusion is final; your job is only to phrase it.',
              '2. Do not reason beyond the conclusion, do not chain new deductions, and do not mention what the raw cast "might also mean". Every claim must be traceable to a fact in the conclusion.',
              '3. Delivery: start with the primary hexagram result, moving line, changed hexagram, and the direct judgment. The viewer question is already on screen; do not repeat it.',
              '4. opening and closing MUST be empty strings. Do not add greetings, introductions, filler, disclaimers, calls to action, or “for reflection” language.',
              '5. Style: natural spoken language, concise and decisive. English should still feel like natural spoken US TikTok delivery; Spanish should feel natural for Latin American audiences. Every claim must remain traceable to the supplied conclusion.',
              '6. The combined opening + speech + closing MUST stay inside the supplied lengthTarget minimum and maximum (words or characters per unit); do not count punctuation.',
              '7. Set estimatedSeconds exactly to targetSeconds; the audio pipeline will use that value for the final duration.',
              '8. Return only JSON matching the schema.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({ username: input.username, question: input.question, language, targetSeconds, lengthTarget, conclusion }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'meihua_answer', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                opening: { type: 'string' }, speech: { type: 'string' },
                keywords: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 32 } },
                closing: { type: 'string' }, estimatedSeconds: { type: 'integer', minimum: 1, maximum: 120 },
              },
              required: ['opening', 'speech', 'keywords', 'closing', 'estimatedSeconds'],
            },
          },
        },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`LLM_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const envelope = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const answer = readJsonContent(envelope.choices?.[0]?.message?.content);
    assertValidAnswerContent(answer);
    const lengthCheck = validateAnswerLength(answer, language, targetSeconds, input.speechRate);
    if (!lengthCheck.ok || !isDirectSpokenAnswer(answer, input, language)) {
      // A compatible model may satisfy JSON Schema while ignoring the spoken
      // length/direct-delivery rules. Keep the provider useful, but never let
      // that violate the queue contract: regenerate deterministically from
      // the same cast facts.
      return new RuleBasedAnswerComposer().compose(input);
    }
    // Keep the duration authoritative even if a provider returns a stale or
    // approximate estimate.  The text length target and the TTS correction
    // stage are both driven by the operator-selected targetSeconds.
    return withAnswerLengthMetrics({ ...answer, estimatedSeconds: targetSeconds }, language, targetSeconds, input.speechRate);
  }
}
