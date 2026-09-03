export type GiftCatalogEntry = {
  key: string;
  name: string;
  coins?: number;
  giftId?: string;
  source: 'CAPTURED' | 'REFERENCE';
  /** Local copy cut from the verified 24-cell TikTok icon sheets. */
  iconUrl?: string;
  verification?: 'TIKFINITY_CAPTURED' | 'DAILY_PLATFORM_CATALOG';
};

type VerifiedGift = readonly [giftId: string, name: string, coins: number, verification?: 'TIKFINITY_CAPTURED'];

// Verified on 2026-08-27. IDs and coin values are checked by
// scripts/build-tiktok-gift-icons.py before the icon sheets are produced.
const verifiedGifts: VerifiedGift[] = [
  ['5269', 'TikTok', 1], ['5655', '玫瑰', 1, 'TIKFINITY_CAPTURED'],
  ['5827', '冰淇淋甜筒', 1], ['6064', 'GG', 1], ['6093', '足球', 1],
  ['6246', '点赞', 1], ['6247', '爱心', 1], ['6788', '荧光棒', 1],
  ['6890', '我爱你', 1], ['7934', '爱我', 1, 'TIKFINITY_CAPTURED'],
  ['15231', '非常爱你', 1, 'TIKFINITY_CAPTURED'],
  ['5487', '手指爱心', 5], ['14786', '桃子', 5],
  ['5480', '十金币爱心', 10], ['9947', '友谊项链', 10],
  ['5658', '香水', 20], ['5879', '甜甜圈', 30],
  ['5659', '千纸鹤', 99], ['6427', '帽子搭配小胡子', 99, 'TIKFINITY_CAPTURED'],
  ['12678', '升级火花', 99, 'TIKFINITY_CAPTURED'],
  ['13087', '泡泡糖', 99, 'TIKFINITY_CAPTURED'],
  ['14109', '爱的印记', 99, 'TIKFINITY_CAPTURED'],
  ['5585', '彩纸礼花', 100], ['5660', '双手爱心', 100],
  ['17359', '毛毛虫总动员', 149, 'TIKFINITY_CAPTURED'], ['5586', '爱心雨', 199],
  ['15191', '糖果花束', 249, 'TIKFINITY_CAPTURED'],
  ['15763', '欢乐麦克风', 249, 'TIKFINITY_CAPTURED'],
  ['17985', '温柔的声音', 249, 'TIKFINITY_CAPTURED'],
  ['6007', '拳击手套', 299], ['6267', '柯基', 299],
  ['8914', '永恒玫瑰', 399], ['5731', '珊瑚', 499],
  ['7168', '钞票枪', 500], ['9948', '你真棒', 500],
  ['5897', '天鹅', 699], ['5978', '火车', 899],
  ['11046', '银河', 1000], ['14397', '精灵翅膀', 1000, 'TIKFINITY_CAPTURED'],
  ['6090', '烟花', 1088], ['7467', '追逐梦想', 1500],
  ['6862', '库珀飞回家', 1999], ['17762', '派对巴士', 2999],
  ['6563', '流星雨', 3000], ['5767', '私人飞机', 4888],
  ['6646', '小猫里昂', 4888, 'TIKFINITY_CAPTURED'],
  ['14769', '英雄宇宙飞船', 4999], ['9500', '飞行喷气机', 5000],
];

export const referenceGiftCatalog: GiftCatalogEntry[] = verifiedGifts.map(([giftId, name, coins, verification]) => ({
  key: `verified:${giftId}`,
  giftId,
  name,
  coins,
  source: 'REFERENCE',
  iconUrl: `/gifts/${giftId}.png`,
  verification: verification ?? 'DAILY_PLATFORM_CATALOG',
}));

const verifiedById = new Map(referenceGiftCatalog.map((gift) => [gift.giftId, gift]));
const verifiedByName = new Map(referenceGiftCatalog.map((gift) => [gift.name.toLocaleLowerCase(), gift]));

export function giftIconUrl(giftId?: string, giftName?: string): string | undefined {
  if (giftId) {
    const byId = verifiedById.get(giftId)?.iconUrl;
    if (byId) return byId;
  }
  return giftName ? verifiedByName.get(giftName.trim().toLocaleLowerCase())?.iconUrl : undefined;
}

export function giftGlyph(name: string): string {
  const value = name.toLocaleLowerCase();
  if (/玫瑰|花|rose|flower|bouquet|coral|shamrock|garland/.test(value)) return '🌹';
  if (/心|爱|heart|love|kiss|wedding/.test(value)) return '💗';
  if (/冰淇淋|桃|甜甜圈|ice cream|melon|peach|doughnut|juice/.test(value)) return '🍦';
  if (/星|银河|流星|宇宙|star|galaxy|meteor|space|rocket|shuttle/.test(value)) return '✨';
  if (/车|飞机|火车|jet|car|train|motorcycle|limo|bus/.test(value)) return '🚀';
  if (/烟花|光|firework|laser|light|spark|glow/.test(value)) return '🎆';
  if (/猫|狗|柯基|天鹅|pig|corgi|swan|hen/.test(value)) return '🐾';
  if (/钱|钻石|money|diamond|coin/.test(value)) return '💎';
  return '🎁';
}
