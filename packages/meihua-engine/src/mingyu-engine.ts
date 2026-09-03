import type { HexagramLine, MeihuaInput, MeihuaResult } from '@meihua/core-types';
import { generateMeihua } from 'mingyu-core/divination/meihua';
import {
  DeterministicMeihuaEngine,
  bodyUseRelationText,
  kingWenNumber,
  linesFromTrigramNames,
  trigramElement,
} from './index.js';

/**
 * V2.2 canonical Meihua engine backed by mingyu-core
 * (邵雍《梅花易数》通行本；MIT 许可)。It passed a fixed-sample dual-cast
 * comparison against the legacy engine (see the evidence test suite), so it
 * became the default runtime engine, with the legacy engine retained behind a
 * settings toggle as the rollback path.
 *
 * Casting policy: timestamps are interpreted as UTC+8 wall time (host
 * independent). Number casting keeps the system's documented multi-number
 * policy; the single-number school difference is recorded in provenance and is
 * deliberately excluded from dual-cast comparison.
 */
export class MingyuMeihuaEngine {
  readonly id = 'mingyu-core';
  private readonly legacy = new DeterministicMeihuaEngine();

  async cast(input: MeihuaInput): Promise<MeihuaResult> {
    if (input.seedPolicy === 'NICKNAME') {
      const username = input.username?.trim() ?? '';
      if (username) return this.castNumbersWithLegacyPolicy(input, 'NICKNAME');
      return this.castNumbersWithLegacyPolicy(input, undefined);
    }
    if ((input.seedPolicy === 'NUMBER' || input.seedPolicy === 'CUSTOM') && ((input.userProvidedNumbers ?? []).filter(Number.isFinite).length >= 2)) {
      return this.castNumbersWithLegacyPolicy(input, undefined);
    }
    const date = new Date(input.receivedAt);
    if (Number.isNaN(date.getTime())) throw new Error('receivedAt must be a valid date');
    const cast = generateMeihua(date, { method: 'time' });
    const primaryName = cast.originalName ?? cast.mainHexagram.name;
    const movingLine = cast.movingYao.position as HexagramLine['index'];
    const primary = {
      name: primaryName,
      number: kingWenNumber(cast.mainHexagram.upper, cast.mainHexagram.lower),
      upperTrigram: cast.mainHexagram.upper,
      lowerTrigram: cast.mainHexagram.lower,
      lines: cast.yaosDetail.map((yao: { position: number; yaoType: '阳' | '阴'; isChanging?: boolean }): HexagramLine => ({
        index: yao.position as HexagramLine['index'],
        yinYang: yao.yaoType === '阳' ? ('YANG' as const) : ('YIN' as const),
        moving: yao.isChanging === true,
      })),
    };
    const changed = cast.changedHexagram
      ? {
          name: cast.changedHexagram.name,
          number: kingWenNumber(cast.changedHexagram.upper, cast.changedHexagram.lower),
          upperTrigram: cast.changedHexagram.upper,
          lowerTrigram: cast.changedHexagram.lower,
          lines: linesFromTrigramNames(cast.changedHexagram.upper, cast.changedHexagram.lower),
        }
      : undefined;
    const mutual = cast.interHexagram
      ? {
          name: cast.interHexagram.name,
          number: kingWenNumber(cast.interHexagram.upper, cast.interHexagram.lower),
          upperTrigram: cast.interHexagram.upper,
          lowerTrigram: cast.interHexagram.lower,
          lines: linesFromTrigramNames(cast.interHexagram.upper, cast.interHexagram.lower),
        }
      : undefined;
    const bodyName = cast.tiGua.name;
    const useName = cast.yongGua.name;
    const relationText = bodyUseRelationText(bodyName, useName);
    const upperElement = trigramElement(cast.mainHexagram.upper);
    const lowerElement = trigramElement(cast.mainHexagram.lower);
    const calc = cast.calculation as
      | { yearZhi?: string; yearZhiIndex?: number; month?: number; day?: number; timeZhi?: string; timeZhiIndex?: number; upperTrigramIndex?: number; lowerTrigramIndex?: number; movingYaoIndex?: number }
      | undefined;
    return {
      primary,
      mutual,
      changed,
      movingLines: [movingLine],
      bodyTrigram: bodyName,
      useTrigram: useName,
      fiveElements: {
        [cast.mainHexagram.upper]: upperElement ?? '',
        [cast.mainHexagram.lower]: lowerElement ?? '',
        体: cast.tiGua.element,
        用: cast.yongGua.element,
      },
      relations: [relationText],
      timingSignals: [`动爻在第 ${movingLine} 爻`, movingLine <= 3 ? '变化先从内部与基础层面展开' : '变化更多显现在外部与后续阶段'],
      interpretationFacts: [
        `本卦为${primary.name}，上${cast.mainHexagram.upper}下${cast.mainHexagram.lower}`,
        `互卦为${mutual?.name ?? '（无）'}，取二三四爻为下互、三四五爻为上互`,
        `第${movingLine}爻动，变卦为${changed?.name ?? '（无）'}`,
        `体卦${bodyName}属${cast.tiGua.element}，用卦${useName}属${cast.yongGua.element}`,
        relationText,
      ],
      warnings: ['采用传统时间/数字起卦的可复现结构算法；不同流派对历法边界可能存在差异，仅用于传统文化互动。'],
      engineVersion: 'meihua-v2.2-mingyu-core',
      provenance: {
        method: 'TRADITIONAL_TIME',
        formula: '上卦=(年支序+农历月+农历日)÷8取余；下卦加时支÷8取余；动爻÷6取余（余0按末位）；时刻按 UTC+8 墙钟解读；年支以正月初一为界',
        source: 'mingyu-core（邵雍《梅花易数》通行本，MIT）；经 40 个固定样本与本系统旧引擎双算比对一致',
        receivedAt: input.receivedAt,
        inputs: {
          solarTime: date.toISOString(),
          yearBranch: `${String(calc?.yearZhi ?? '')}(${calc?.yearZhiIndex ?? ''})`,
          lunarMonth: calc?.month ?? 0,
          lunarDay: calc?.day ?? 0,
          hourBranch: calc?.timeZhiIndex ?? 0,
          upper: calc?.upperTrigramIndex ?? 0,
          lower: calc?.lowerTrigramIndex ?? 0,
          moving: calc?.movingYaoIndex ?? 0,
        },
      },
    };
  }

  private async castNumbersWithLegacyPolicy(input: MeihuaInput, method: 'NICKNAME' | undefined): Promise<MeihuaResult> {
    // The multi-number 报数 policy (upper=first number, lower=second, moving =
    // third or sum) is documented and unchanged. The nickname policy is the
    // deterministic viewer-key conversion into that same number policy; the
    // authoritative engine's single-number policy adds the hour branch, so the
    // schools are recorded side by side instead of being silently merged.
    const result = await this.legacy.cast(input);
    const methodLabel = method === 'NICKNAME' ? '（昵称起卦，确定性码位换算）' : '';
    return {
      ...result,
      engineVersion: 'meihua-v2.2-mingyu-core-number-policy',
      provenance: {
        ...(result.provenance ?? { method: 'NUMBER' as const, formula: '', source: '', receivedAt: input.receivedAt, inputs: {} }),
        source: `${result.provenance?.source ?? ''}；数字口径为本系统多报数策略${methodLabel}（mingyu-core 为单数+时支策略，存在流派差异，不参与双算比对）`,
      },
    };
  }
}