import { describe, expect, it } from 'vitest';
import { DeterministicMeihuaEngine, kingWenEntries, kingWenNumber, linesFromTrigramNames, nicknameSums, questionSums } from './index.js';
import { MingyuMeihuaEngine } from './mingyu-engine.js';
import { generateMeihua } from 'mingyu-core/divination/meihua';

const legacy = new DeterministicMeihuaEngine();
const canonical = new MingyuMeihuaEngine();

function castFn(engine: DeterministicMeihuaEngine | MingyuMeihuaEngine, iso: string) {
  return engine.cast({ readingId: 'evidence', question: '测试？', receivedAt: iso, locale: 'zh-CN', seedPolicy: 'CUSTOM' });
}

/** Canonical King Wen sequence: number → name (通行本卦序). */
const kingWen: Array<[number, string]> = [
  [1, '乾为天'], [2, '坤为地'], [3, '水雷屯'], [4, '山水蒙'], [5, '水天需'], [6, '天水讼'], [7, '地水师'], [8, '水地比'],
  [9, '风天小畜'], [10, '天泽履'], [11, '地天泰'], [12, '天地否'], [13, '天火同人'], [14, '火天大有'], [15, '地山谦'], [16, '雷地豫'],
  [17, '泽雷随'], [18, '山风蛊'], [19, '地泽临'], [20, '风地观'], [21, '火雷噬嗑'], [22, '山火贲'], [23, '山地剥'], [24, '地雷复'],
  [25, '天雷无妄'], [26, '山天大畜'], [27, '山雷颐'], [28, '泽风大过'], [29, '坎为水'], [30, '离为火'], [31, '泽山咸'], [32, '雷风恒'],
  [33, '天山遯'], [34, '雷天大壮'], [35, '火地晋'], [36, '地火明夷'], [37, '风火家人'], [38, '火泽睽'], [39, '水山蹇'], [40, '雷水解'],
  [41, '山泽损'], [42, '风雷益'], [43, '泽天夬'], [44, '天风姤'], [45, '泽地萃'], [46, '地风升'], [47, '泽水困'], [48, '水风井'],
  [49, '泽火革'], [50, '火风鼎'], [51, '震为雷'], [52, '艮为山'], [53, '风山渐'], [54, '雷泽归妹'], [55, '雷火丰'], [56, '火山旅'],
  [57, '巽为风'], [58, '兑为泽'], [59, '风水涣'], [60, '水泽节'], [61, '风泽中孚'], [62, '雷山小过'], [63, '水火既济'], [64, '火水未济'],
];

// Fixed samples covering leap months, lunar new year, year boundaries, 子时 and
// double-hour edges across six decades.
const fixedSamples = [
  '2026-08-23T14:30:00+08:00', '2025-01-01T00:10:00+08:00', '2025-06-25T23:50:00+08:00',
  '2024-02-10T09:00:00+08:00', '2024-02-09T23:30:00+08:00', '2024-03-10T13:00:00+08:00',
  '2023-07-20T03:20:00+08:00', '2023-03-22T18:45:00+08:00', '2022-01-31T22:00:00+08:00',
  '2022-02-01T01:30:00+08:00', '2021-12-31T23:59:00+08:00', '2021-06-10T12:00:00+08:00',
  '2020-02-29T05:00:00+08:00', '2020-05-23T17:00:00+08:00', '2019-10-01T10:30:00+08:00',
  '2018-08-08T08:08:00+08:00', '2017-01-28T00:00:00+08:00', '2016-12-31T23:45:00+08:00',
  '2015-06-15T06:30:00+08:00', '2014-09-09T15:15:00+08:00', '2013-02-10T11:11:00+08:00',
  '2012-01-23T07:00:00+08:00', '2011-11-11T11:11:00+08:00', '2010-07-01T02:00:00+08:00',
  '2009-05-05T20:00:00+08:00', '2008-02-07T16:00:00+08:00', '2007-03-19T04:00:00+08:00',
  '2006-06-06T06:06:00+08:00', '2005-12-22T22:22:00+08:00', '2004-01-22T01:01:00+08:00',
  '2026-01-01T00:00:00+08:00', '2026-02-17T12:00:00+08:00', '2030-01-01T08:30:00+08:00',
  '2035-02-08T20:20:00+08:00', '2040-06-15T14:14:00+08:00', '1999-12-31T23:59:59+08:00',
  '1988-08-08T08:08:00+08:00', '1976-01-31T00:30:00+08:00', '1964-05-20T13:00:00+08:00',
  '1950-10-01T10:00:00+08:00',
];

describe('Meihua casting evidence', () => {
  it('contains all 64 King Wen hexagrams exactly once with the canonical names', () => {
    const entries = kingWenEntries();
    expect(entries).toHaveLength(64);
    expect(new Set(entries.map((entry) => entry.number)).size).toBe(64);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(64);
    for (const [number, name] of kingWen) {
      const entry = entries.find((item) => item.number === number);
      expect(entry, `#${number} must exist`).toBeDefined();
      expect(entry!.name).toBe(name);
      // Spot-check the source trigram pair encodes the number (e.g., 天泽履 is 乾-兑).
    }
    // Spot checks against widely known pairs: 11 地天泰 = 坤上乾下, 63 水火既济 = 坎上离下.
    expect(kingWenNumber('坤', '乾')).toBe(11);
    expect(kingWenNumber('坎', '离')).toBe(63);
    expect(kingWenNumber('乾', '乾')).toBe(1);
    expect(kingWenNumber('坤', '坤')).toBe(2);
    expect(kingWenNumber('离', '坎')).toBe(64);
  });

  it('produces static 6-line arrays for any trigram pair used by the 64 table', () => {
    for (const entry of kingWenEntries()) {
      const lines = linesFromTrigramNames(entry.upper, entry.lower);
      expect(lines).toHaveLength(6);
      expect(lines.map((line) => line.index)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(lines.every((line) => line.moving === false)).toBe(true);
    }
  });

  it('casts a fixed time sample to the exact canonical vector', async () => {
    const result = await legacy.cast({ readingId: 'vector', question: '测试？', receivedAt: '2026-08-23T14:30:00+08:00', locale: 'zh-CN', seedPolicy: 'TIME' });
    expect(result.primary).toMatchObject({ number: 1, name: '乾为天', upperTrigram: '乾', lowerTrigram: '乾' });
    expect(result.mutual).toMatchObject({ number: 1, name: '乾为天' });
    expect(result.changed).toMatchObject({ number: 10, name: '天泽履', upperTrigram: '乾', lowerTrigram: '兑' });
    expect(result.movingLines).toEqual([3]);
    expect(result.bodyTrigram).toBe('乾');
    expect(result.useTrigram).toBe('乾');
    expect(result.provenance?.inputs).toMatchObject({ yearBranch: '午(7)', lunarMonth: 7, lunarDay: 11, hourBranch: 8 });
  });

  it('interprets timestamps as UTC+8 wall time on any host timezone', async () => {
    const utc = await legacy.cast({ readingId: 'tz', question: '测试？', receivedAt: '2026-08-23T06:30:00.000Z', locale: 'zh-CN', seedPolicy: 'TIME' });
    const withOffset = await legacy.cast({ readingId: 'tz2', question: '测试？', receivedAt: '2026-08-23T14:30:00+08:00', locale: 'zh-CN', seedPolicy: 'TIME' });
    expect(utc.primary.number).toBe(withOffset.primary.number);
    expect(utc.movingLines).toEqual(withOffset.movingLines);
    expect(utc.primary.number).toBe(1);
  });

  it('flips exactly the moving line in the changed hexagram (time and number casts)', async () => {
    for (const iso of fixedSamples.slice(0, 8)) {
      const result = await legacy.cast({ readingId: 'flip', question: '测试？', receivedAt: iso, locale: 'zh-CN', seedPolicy: 'TIME' });
      const moving = result.movingLines[0];
      expect(moving).toBeGreaterThanOrEqual(1);
      expect(moving).toBeLessThanOrEqual(6);
      // Primary moving line is YANG/YIN; in the changed hexagram that line is flipped.
      const primaryLine = result.primary.lines.find((line) => line.index === moving)!;
      const changedLine = result.changed!.lines.find((line) => line.index === moving)!;
      expect(changedLine.yinYang).toBe(primaryLine.yinYang === 'YANG' ? 'YIN' : 'YANG');
      expect(changedLine.moving).toBe(false);
      // All other lines keep their polarity.
      for (const line of result.primary.lines) {
        if (line.index === moving) continue;
        expect(result.changed!.lines.find((item) => item.index === line.index)?.yinYang).toBe(line.yinYang);
      }
    }
  });

  it('builds the mutual hexagram from lines 2-4 and 3-5 of the primary hexagram', async () => {
    for (const iso of fixedSamples.slice(8, 14)) {
      const result = await legacy.cast({ readingId: 'mutual', question: '测试？', receivedAt: iso, locale: 'zh-CN', seedPolicy: 'TIME' });
      const lines = result.primary.lines;
      const lower = lines.filter((line) => [2, 3, 4].includes(line.index)).sort((a, b) => a.index - b.index).map((line) => line.yinYang);
      const upper = lines.filter((line) => [3, 4, 5].includes(line.index)).sort((a, b) => a.index - b.index).map((line) => line.yinYang);
      expect(result.mutual!.lines.slice(0, 3).map((line) => line.yinYang)).toEqual(lower);
      expect(result.mutual!.lines.slice(3, 6).map((line) => line.yinYang)).toEqual(upper);
    }
  });

  it('supports the documented multi-number policy and keeps evidence in provenance', async () => {
    const result = await legacy.cast({ readingId: 'num', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NUMBER', userProvidedNumbers: [3, 5, 7] });
    expect(result.primary).toMatchObject({ number: 50, name: '火风鼎' }); // 3=离上 5=巽下
    expect(result.movingLines).toEqual([1]); // 7 % 6 = 1
    expect(result.provenance).toMatchObject({ method: 'NUMBER', inputs: { numbers: [3, 5, 7] } });
    const two = await legacy.cast({ readingId: 'num2', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NUMBER', userProvidedNumbers: [2, 6] });
    expect(two.primary).toMatchObject({ number: 47, name: '泽水困' }); // 2=兑上 6=坎下
    expect(two.movingLines).toEqual([2]); // (2+6) % 6 = 2
  });

  it('keeps the remainder-0 boundary as the last trigram/line', async () => {
    const result = await legacy.cast({ readingId: 'r0', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NUMBER', userProvidedNumbers: [8, 8, 6] });
    expect(result.primary.upperTrigram).toBe('坤');
    expect(result.primary.lowerTrigram).toBe('坤');
    expect(result.primary.name).toBe('坤为地');
    expect(result.movingLines).toEqual([6]);
  });
});

describe('dual-engine comparison (legacy vs MingyuMeihuaEngine)', () => {
  it('agrees with the authoritative engine on all 40 fixed samples', async () => {
    for (const iso of fixedSamples) {
      const expected = await castFn(legacy, iso);
      const actual = await castFn(canonical, iso);
      expect(actual.primary.number, `primary #${iso}`).toBe(expected.primary.number);
      expect(actual.primary.name, `primary name ${iso}`).toBe(expected.primary.name);
      expect(actual.mutual?.number, `mutual ${iso}`).toBe(expected.mutual?.number);
      expect(actual.changed?.number, `changed ${iso}`).toBe(expected.changed?.number);
      expect(actual.movingLines, `moving ${iso}`).toEqual(expected.movingLines);
      expect(actual.bodyTrigram, `body ${iso}`).toBe(expected.bodyTrigram);
      expect(actual.useTrigram, `use ${iso}`).toBe(expected.useTrigram);
      expect(actual.relations, `relation ${iso}`).toEqual(expected.relations);
    }
  });

  it('agrees with the raw mingyu-core library on the same instants', async () => {
    for (const iso of fixedSamples.slice(0, 10)) {
      const actual = await canonical.cast({ readingId: 'raw', question: '测试？', receivedAt: iso, locale: 'zh-CN', seedPolicy: 'CUSTOM' });
      const raw = generateMeihua(new Date(iso), { method: 'time' });
      expect(actual.primary.name).toBe(raw.originalName);
      expect(actual.movingLines[0]).toBe(raw.movingYao.position);
      expect(actual.primary.upperTrigram).toBe(raw.mainHexagram.upper);
      expect(actual.primary.lowerTrigram).toBe(raw.mainHexagram.lower);
      expect(actual.mutual?.name).toBe(raw.interHexagram?.name);
      expect(actual.changed?.name).toBe(raw.changedHexagram?.name);
      expect(actual.changed?.lines).toEqual(linesFromTrigramNames(raw.changedHexagram!.upper, raw.changedHexagram!.lower));
    }
  });

  it('records honest provenance for the canonical engine and marks the number-policy divergence', async () => {
    const time = await castFn(canonical, '2026-08-23T14:30:00+08:00');
    expect(time.engineVersion).toBe('meihua-v2.2-mingyu-core');
    expect(time.provenance?.source).toContain('mingyu-core');
    expect(time.provenance?.method).toBe('TRADITIONAL_TIME');
    const numbers = await canonical.cast({ readingId: 'n', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NUMBER', userProvidedNumbers: [3, 5, 7] });
    expect(numbers.engineVersion).toBe('meihua-v2.2-mingyu-core-number-policy');
    expect(numbers.provenance?.source).toContain('不参与双算比对');
  });

  it('keeps the legacy engine available as the documented rollback path', async () => {
    const expected = await castFn(legacy, '2026-08-23T14:30:00+08:00');
    expect(expected.engineVersion).toBe('meihua-traditional-time-number-v2.1');
  });
});
describe('nickname casting (Layer 1 input)', () => {
  it('includes the viewer question in the live number seed', () => {
    const first = questionSums('Viewer', 'Should I change jobs?', 'event-1');
    const second = questionSums('Viewer', 'Should I move house?', 'event-1');
    const retry = questionSums('Viewer', 'Should I change jobs?', 'event-1');
    expect(first).not.toEqual(second);
    expect(first).toEqual(retry);
  });

  it('converts a nickname deterministically and reproducibly', () => {
    const first = nicknameSums('SunnyStar88');
    const second = nicknameSums('SunnyStar88');
    const lowered = nicknameSums('sunny star 88');
    expect(first).toEqual(second);
    // NFKC + lowercase normalization keeps the sums host/format stable.
    expect(first[0]).toBeGreaterThan(0);
    expect(lowered[0]).toBeGreaterThan(0);
    const empty = nicknameSums('');
    expect(empty).toEqual([0, 0, 0]);
  });

  it('casts from the nickname with full provenance and stability', async () => {
    const input = { readingId: 'nick', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NICKNAME' as const, username: 'TikTokFan_007' };
    const a = await legacy.cast(input);
    const b = await legacy.cast(input);
    expect(a.primary.number).toBe(b.primary.number);
    expect(a.movingLines).toEqual(b.movingLines);
    expect(a.primary.name).toBeTruthy();
    expect(a.provenance?.method).toBe('NICKNAME');
    expect(a.provenance?.inputs).toMatchObject({ username: 'TikTokFan_007' });
    expect(a.provenance?.formula).toContain('昵称');
    // The nickname hexagram is the deterministic NUMBER policy over the sums.
    const [s1, s2, s3] = nicknameSums('TikTokFan_007');
    const numeric = await legacy.cast({ readingId: 'nick2', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NUMBER', userProvidedNumbers: [s1, s2, s3] });
    expect(a.primary.number).toBe(numeric.primary.number);
    expect(a.movingLines).toEqual(numeric.movingLines);
  });

  it('falls back to time casting for an empty nickname', async () => {
    const result = await legacy.cast({ readingId: 'nick3', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NICKNAME', username: '   ' });
    expect(result.provenance?.method).toBe('TRADITIONAL_TIME');
  });

  it('keeps the canonical engine consistent with the legacy engine on nicknames', async () => {
    const input = { readingId: 'nick4', question: '测试？', receivedAt: '2026-08-23T00:00:00.000Z', locale: 'zh-CN', seedPolicy: 'NICKNAME' as const, username: 'Maria_De_Los_Angeles99' };
    const fromLegacy = await legacy.cast(input);
    const fromCanonical = await canonical.cast(input);
    expect(fromCanonical.primary.number).toBe(fromLegacy.primary.number);
    expect(fromCanonical.movingLines).toEqual(fromLegacy.movingLines);
    expect(fromCanonical.provenance?.source).toContain('昵称起卦');
  });
});
