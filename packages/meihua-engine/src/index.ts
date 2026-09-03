import type { HexagramLine, MeihuaInput, MeihuaResult } from '@meihua/core-types';
// lunar-javascript does not publish TypeScript declarations; the narrow surface is declared locally.
// @ts-expect-error third-party CommonJS package without bundled types
import { Solar } from 'lunar-javascript';

export interface MeihuaEngine {
  cast(input: MeihuaInput): Promise<MeihuaResult>;
}

type Trigram = { number: number; name: string; element: string; lines: Array<'YIN' | 'YANG'> };
type HexagramInfo = { number: number; name: string };

// Traditional 1–8 trigram number order used by the time/number casting policy.
const trigrams: Record<number, Trigram> = {
  1: { number: 1, name: '乾', element: '金', lines: ['YANG', 'YANG', 'YANG'] },
  2: { number: 2, name: '兑', element: '金', lines: ['YANG', 'YANG', 'YIN'] },
  3: { number: 3, name: '离', element: '火', lines: ['YANG', 'YIN', 'YANG'] },
  4: { number: 4, name: '震', element: '木', lines: ['YANG', 'YIN', 'YIN'] },
  5: { number: 5, name: '巽', element: '木', lines: ['YIN', 'YANG', 'YANG'] },
  6: { number: 6, name: '坎', element: '水', lines: ['YIN', 'YANG', 'YIN'] },
  7: { number: 7, name: '艮', element: '土', lines: ['YIN', 'YIN', 'YANG'] },
  8: { number: 8, name: '坤', element: '土', lines: ['YIN', 'YIN', 'YIN'] },
};

export function trigramElement(name: string): string | undefined {
  return Object.values(trigrams).find((trigram) => trigram.name === name)?.element;
}

export function kingWenNumber(upperTrigramName: string, lowerTrigramName: string): number | undefined {
  return hexagrams[`${upperTrigramName}-${lowerTrigramName}`]?.number;
}

/** Every King Wen hexagram as [number, name, upper trigram, lower trigram]. */
export function kingWenEntries(): Array<{ number: number; name: string; upper: string; lower: string }> {
  return Object.entries(hexagrams).map(([key, value]) => {
    const [upper, lower] = key.split('-');
    return { number: value.number, name: value.name, upper, lower };
  });
}

/** Static lines for an upper/lower trigram pair; no moving line. */
export function linesFromTrigramNames(upperTrigramName: string, lowerTrigramName: string): HexagramLine[] {
  const upper = Object.values(trigrams).find((trigram) => trigram.name === upperTrigramName);
  const lower = Object.values(trigrams).find((trigram) => trigram.name === lowerTrigramName);
  if (!upper || !lower) throw new Error(`Unknown trigram pair: ${upperTrigramName}-${lowerTrigramName}`);
  return [...lower.lines, ...upper.lines].map((yinYang, offset) => ({
    index: (offset + 1) as HexagramLine['index'],
    yinYang,
    moving: false,
  }));
}

export function bodyUseRelationText(bodyTrigramName: string, useTrigramName: string): string {
  const body = Object.values(trigrams).find((trigram) => trigram.name === bodyTrigramName);
  const use = Object.values(trigrams).find((trigram) => trigram.name === useTrigramName);
  if (!body || !use) return '体用关系需要结合具体问题审慎理解';
  return relation(body, use);
}

const hexagrams: Record<string, HexagramInfo> = {
  '乾-乾': { number: 1, name: '乾为天' }, '乾-兑': { number: 10, name: '天泽履' }, '乾-离': { number: 13, name: '天火同人' }, '乾-震': { number: 25, name: '天雷无妄' }, '乾-巽': { number: 44, name: '天风姤' }, '乾-坎': { number: 6, name: '天水讼' }, '乾-艮': { number: 33, name: '天山遯' }, '乾-坤': { number: 12, name: '天地否' },
  '兑-乾': { number: 43, name: '泽天夬' }, '兑-兑': { number: 58, name: '兑为泽' }, '兑-离': { number: 49, name: '泽火革' }, '兑-震': { number: 17, name: '泽雷随' }, '兑-巽': { number: 28, name: '泽风大过' }, '兑-坎': { number: 47, name: '泽水困' }, '兑-艮': { number: 31, name: '泽山咸' }, '兑-坤': { number: 45, name: '泽地萃' },
  '离-乾': { number: 14, name: '火天大有' }, '离-兑': { number: 38, name: '火泽睽' }, '离-离': { number: 30, name: '离为火' }, '离-震': { number: 21, name: '火雷噬嗑' }, '离-巽': { number: 50, name: '火风鼎' }, '离-坎': { number: 64, name: '火水未济' }, '离-艮': { number: 56, name: '火山旅' }, '离-坤': { number: 35, name: '火地晋' },
  '震-乾': { number: 34, name: '雷天大壮' }, '震-兑': { number: 54, name: '雷泽归妹' }, '震-离': { number: 55, name: '雷火丰' }, '震-震': { number: 51, name: '震为雷' }, '震-巽': { number: 32, name: '雷风恒' }, '震-坎': { number: 40, name: '雷水解' }, '震-艮': { number: 62, name: '雷山小过' }, '震-坤': { number: 16, name: '雷地豫' },
  '巽-乾': { number: 9, name: '风天小畜' }, '巽-兑': { number: 61, name: '风泽中孚' }, '巽-离': { number: 37, name: '风火家人' }, '巽-震': { number: 42, name: '风雷益' }, '巽-巽': { number: 57, name: '巽为风' }, '巽-坎': { number: 59, name: '风水涣' }, '巽-艮': { number: 53, name: '风山渐' }, '巽-坤': { number: 20, name: '风地观' },
  '坎-乾': { number: 5, name: '水天需' }, '坎-兑': { number: 60, name: '水泽节' }, '坎-离': { number: 63, name: '水火既济' }, '坎-震': { number: 3, name: '水雷屯' }, '坎-巽': { number: 48, name: '水风井' }, '坎-坎': { number: 29, name: '坎为水' }, '坎-艮': { number: 39, name: '水山蹇' }, '坎-坤': { number: 8, name: '水地比' },
  '艮-乾': { number: 26, name: '山天大畜' }, '艮-兑': { number: 41, name: '山泽损' }, '艮-离': { number: 22, name: '山火贲' }, '艮-震': { number: 27, name: '山雷颐' }, '艮-巽': { number: 18, name: '山风蛊' }, '艮-坎': { number: 4, name: '山水蒙' }, '艮-艮': { number: 52, name: '艮为山' }, '艮-坤': { number: 23, name: '山地剥' },
  '坤-乾': { number: 11, name: '地天泰' }, '坤-兑': { number: 19, name: '地泽临' }, '坤-离': { number: 36, name: '地火明夷' }, '坤-震': { number: 24, name: '地雷复' }, '坤-巽': { number: 46, name: '地风升' }, '坤-坎': { number: 7, name: '地水师' }, '坤-艮': { number: 15, name: '地山谦' }, '坤-坤': { number: 2, name: '坤为地' },
};

const generates: Record<string, string> = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const controls: Record<string, string> = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };

function normalizedModulo(value: number, modulo: number): number {
  return (((Math.trunc(value) - 1) % modulo) + modulo) % modulo + 1;
}

/**
 * Host-independent wall-clock policy for time casting: every instant is
 * interpreted as Asia/Shanghai (UTC+8) wall time, matching the operator's
 * Chinese stream room and the authoritative reference engine. Because the
 * shift is explicit, results are identical on any host timezone.
 */
const CAST_WALL_CLOCK_OFFSET_MS = 8 * 3_600_000;

function hourBranch(wallHour: number): number {
  return Math.floor(((wallHour + 1) % 24) / 2) + 1;
}

type CastNumbers = {
  upper: number;
  lower: number;
  moving: number;
  method: 'TRADITIONAL_TIME' | 'NUMBER' | 'NICKNAME';
  inputs: Record<string, string | number | number[]>;
};

const earthlyBranches = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/**
 * Deterministic nickname → numbers conversion (Layer 1 of the prediction
 * pipeline). The same nickname always yields the same three sums on any host,
 * so every viewer gets one stable hexagram across retries and re-reads:
 *   S1 = Σ Unicode code points (NFKC, lowercased)
 *   S2 = Σ (position+1) × code point   (order-weighted)
 *   S3 = S1 + S2 + character count
 * The three sums then feed the standard number-casting remainder policy
 * (÷8 / ÷8 / ÷6, remainder 0 counts as the last trigram/line).
 */
export function nicknameSums(username: string): [number, number, number] {
  const chars = [...username.normalize('NFKC').toLocaleLowerCase()];
  if (!chars.length) return [0, 0, 0];
  let s1 = 0;
  let s2 = 0;
  for (const [index, char] of chars.entries()) {
    const codePoint = char.codePointAt(0) ?? 0;
    s1 += codePoint;
    s2 += (index + 1) * codePoint;
  }
  return [s1, s2, s1 + s2 + chars.length];
}

/**
 * Live-question seed for the standard number method. Unlike nicknameSums,
 * this includes the actual question and source event, so one viewer asking
 * different questions does not receive one permanently cached hexagram.
 * Keeping the event id in the input makes retries of the same reading stable.
 */
export function questionSums(username: string, question: string, sourceEventId: string): [number, number, number] {
  return nicknameSums([username, question, sourceEventId].join('|'));
}

function timeNumbers(date: Date): CastNumbers {
  const shifted = new Date(date.getTime() + CAST_WALL_CLOCK_OFFSET_MS);
  const lunar = Solar.fromYmd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()).getLunar();
  // Traditional Meihua practice switches the year branch at the lunar new year
  // (正月初一), not at 立春; the non-exact getYearInGanZhi follows that and
  // keeps parity with the authoritative reference engine.
  const ganzhi = lunar.getYearInGanZhi();
  const yearBranchName = ganzhi.slice(-1);
  const yearBranch = Math.max(1, earthlyBranches.indexOf(yearBranchName) + 1);
  const lunarMonth = Math.abs(lunar.getMonth());
  const lunarDay = lunar.getDay();
  const branch = hourBranch(shifted.getUTCHours());
  const upperSum = yearBranch + lunarMonth + lunarDay;
  const total = upperSum + branch;
  return {
    upper: normalizedModulo(upperSum, 8),
    lower: normalizedModulo(total, 8),
    moving: normalizedModulo(total, 6),
    method: 'TRADITIONAL_TIME',
    inputs: {
      solarTime: date.toISOString(),
      lunarDate: `${lunar.getYear()}-${lunarMonth}-${lunarDay}`,
      yearBranch: `${yearBranchName}(${yearBranch})`,
      lunarMonth,
      lunarDay,
      hourBranch: branch,
      upperSum,
      total,
    },
  };
}

function castNumbers(input: MeihuaInput): CastNumbers {
  const provided = input.userProvidedNumbers?.filter(Number.isFinite) ?? [];
  if ((input.seedPolicy === 'NUMBER' || input.seedPolicy === 'CUSTOM') && provided.length >= 2) {
    const upper = normalizedModulo(provided[0], 8);
    const lower = normalizedModulo(provided[1], 8);
    return {
      upper,
      lower,
      moving: normalizedModulo(provided.length >= 3 ? provided[2] : provided[0] + provided[1], 6),
      method: 'NUMBER',
      inputs: { numbers: provided, upperRemainder: upper, lowerRemainder: lower },
    };
  }
  if (input.seedPolicy === 'NICKNAME') {
    const username = input.username?.trim() ?? '';
    if (!username) return timeNumbers(new Date(input.receivedAt));
    const [s1, s2, s3] = nicknameSums(username);
    const upper = normalizedModulo(s1, 8);
    const lower = normalizedModulo(s2, 8);
    return {
      upper,
      lower,
      moving: normalizedModulo(s3, 6),
      method: 'NICKNAME',
      inputs: { username, sums: [s1, s2, s3], upperRemainder: upper, lowerRemainder: lower },
    };
  }
  const date = new Date(input.receivedAt);
  if (Number.isNaN(date.getTime())) throw new Error('receivedAt must be a valid date');
  return timeNumbers(date);
}

function linesFor(upper: Trigram, lower: Trigram, movingLine: number): HexagramLine[] {
  return [...lower.lines, ...upper.lines].map((yinYang, offset) => ({
    index: (offset + 1) as HexagramLine['index'], yinYang, moving: offset + 1 === movingLine,
  }));
}

function trigramFromLines(lines: HexagramLine[], start: number): Trigram {
  const signature = lines.slice(start, start + 3).map((line) => line.yinYang).join('|');
  const found = Object.values(trigrams).find((trigram) => trigram.lines.join('|') === signature);
  if (!found) throw new Error('Unable to resolve trigram from lines');
  return found;
}

function hexagramFor(upper: Trigram, lower: Trigram): HexagramInfo {
  const value = hexagrams[`${upper.name}-${lower.name}`];
  if (!value) throw new Error(`Unknown hexagram: ${upper.name}-${lower.name}`);
  return value;
}

function relation(body: Trigram, use: Trigram): string {
  if (body.element === use.element) return '体用比和，整体条件相互呼应';
  if (generates[use.element] === body.element) return '用生体，外部条件对自身形成助力';
  if (generates[body.element] === use.element) return '体生用，自身投入较多，宜控制消耗';
  if (controls[body.element] === use.element) return '体克用，自身有主动掌控空间';
  if (controls[use.element] === body.element) return '用克体，外部阻力较强，宜先稳后动';
  return '体用关系需要结合具体问题审慎理解';
}

export { MingyuMeihuaEngine } from './mingyu-engine.js';

/**
 * Deterministic V1 engine using the documented time/number casting policy.
 * It produces structure only; interpretive copy is handled by the composer.
 */
export class DeterministicMeihuaEngine implements MeihuaEngine {
  async cast(input: MeihuaInput): Promise<MeihuaResult> {
    const cast = castNumbers(input);
    const { upper: upperNumber, lower: lowerNumber, moving: movingLine } = cast;
    const upper = trigrams[upperNumber];
    const lower = trigrams[lowerNumber];
    const lines = linesFor(upper, lower, movingLine);
    const primaryInfo = hexagramFor(upper, lower);
    const changedLines = lines.map((line): HexagramLine => line.moving
      ? { ...line, moving: false, yinYang: line.yinYang === 'YANG' ? 'YIN' : 'YANG' }
      : { ...line, moving: false });
    const changedLower = trigramFromLines(changedLines, 0);
    const changedUpper = trigramFromLines(changedLines, 3);
    const changedInfo = hexagramFor(changedUpper, changedLower);
    // Mutual hexagram: lines 2-4 form the lower trigram; lines 3-5 form the upper.
    const mutualLines: HexagramLine[] = [lines[1], lines[2], lines[3], lines[2], lines[3], lines[4]].map((line, offset) => ({
      index: (offset + 1) as HexagramLine['index'],
      yinYang: line.yinYang,
      moving: false,
    }));
    const mutualLower = trigramFromLines(mutualLines, 0);
    const mutualUpper = trigramFromLines(mutualLines, 3);
    const mutualInfo = hexagramFor(mutualUpper, mutualLower);
    const useTrigram = movingLine <= 3 ? lower : upper;
    const bodyTrigram = movingLine <= 3 ? upper : lower;
    const bodyUseRelation = relation(bodyTrigram, useTrigram);

    return {
      primary: { name: primaryInfo.name, number: primaryInfo.number, upperTrigram: upper.name, lowerTrigram: lower.name, lines },
      mutual: { name: mutualInfo.name, number: mutualInfo.number, upperTrigram: mutualUpper.name, lowerTrigram: mutualLower.name, lines: mutualLines },
      changed: { name: changedInfo.name, number: changedInfo.number, upperTrigram: changedUpper.name, lowerTrigram: changedLower.name, lines: changedLines },
      movingLines: [movingLine],
      bodyTrigram: bodyTrigram.name,
      useTrigram: useTrigram.name,
      fiveElements: { [upper.name]: upper.element, [lower.name]: lower.element, 体: bodyTrigram.element, 用: useTrigram.element },
      relations: [bodyUseRelation],
      timingSignals: [`动爻在第 ${movingLine} 爻`, movingLine <= 3 ? '变化先从内部与基础层面展开' : '变化更多显现在外部与后续阶段'],
      interpretationFacts: [
        `本卦为${primaryInfo.name}，上${upper.name}下${lower.name}`,
        `互卦为${mutualInfo.name}，取二三四爻为下互、三四五爻为上互`,
        `第${movingLine}爻动，变卦为${changedInfo.name}`,
        `体卦${bodyTrigram.name}属${bodyTrigram.element}，用卦${useTrigram.name}属${useTrigram.element}`,
        bodyUseRelation,
      ],
      warnings: ['采用传统时间/数字起卦的可复现结构算法；不同流派对历法边界可能存在差异，仅用于传统文化互动。'],
      engineVersion: 'meihua-traditional-time-number-v2.1',
      provenance: {
        method: cast.method,
        formula: cast.method === 'TRADITIONAL_TIME'
          ? '上卦=(年支序+农历月+农历日)÷8取余；下卦加时支÷8取余；动爻÷6取余（余0按末位）；时刻按 UTC+8 墙钟解读'
          : cast.method === 'NICKNAME'
            ? '昵称码位和÷8取余为上卦；加权码位和÷8取余为下卦；(两和+字数)÷6取余为动爻（余0按末位）'
            : '上卦=第一数÷8取余；下卦=第二数÷8取余；动爻=第三数或前两数和÷6取余（余0按末位）',
        source: 'Cross-validated against MIT-licensed handsomejustin/meihua-yi; lunar conversion by lunar-javascript',
        receivedAt: input.receivedAt,
        inputs: cast.inputs,
      },
    };
  }
}
