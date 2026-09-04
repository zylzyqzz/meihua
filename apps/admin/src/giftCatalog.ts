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
  ['5269', 'TikTok', 1], ['5655', 'Rose', 1, 'TIKFINITY_CAPTURED'],
  ['5827', 'Ice Cream Cone', 1], ['6064', 'GG', 1], ['6093', 'Football', 1],
  ['6246', 'Thumbs Up', 1], ['6247', 'Heart', 1], ['6788', 'Glow Stick', 1],
  ['6890', 'I Love You', 1], ['7934', 'Love Me', 1, 'TIKFINITY_CAPTURED'],
  ['15231', 'Love You So Much', 1, 'TIKFINITY_CAPTURED'],
  ['5487', 'Finger Heart', 5], ['14786', 'Peach', 5],
  ['5480', 'Ten Coin Heart', 10], ['9947', 'Friendship Necklace', 10],
  ['5658', 'Perfume', 20], ['5879', 'Doughnut', 30],
  ['5659', 'Paper Crane', 99], ['6427', 'Hat and Mustache', 99, 'TIKFINITY_CAPTURED'],
  ['12678', 'Level-up Spark', 99, 'TIKFINITY_CAPTURED'],
  ['13087', 'Bubble Gum', 99, 'TIKFINITY_CAPTURED'],
  ['14109', 'Mark of Love', 99, 'TIKFINITY_CAPTURED'],
  ['5585', 'Confetti', 100], ['5660', 'Hands Heart', 100],
  ['17359', 'Caterpillar Party', 149, 'TIKFINITY_CAPTURED'], ['5586', 'Heart Rain', 199],
  ['15191', 'Candy Bouquet', 249, 'TIKFINITY_CAPTURED'],
  ['15763', 'Cheerful Microphone', 249, 'TIKFINITY_CAPTURED'],
  ['17985', 'Gentle Voice', 249, 'TIKFINITY_CAPTURED'],
  ['6007', 'Boxing Gloves', 299], ['6267', 'Corgi', 299],
  ['8914', 'Eternal Rose', 399], ['5731', 'Coral', 499],
  ['7168', 'Money Gun', 500], ['9948', 'You Are Awesome', 500],
  ['5897', 'Swan', 699], ['5978', 'Train', 899],
  ['11046', 'Galaxy', 1000], ['14397', 'Fairy Wings', 1000, 'TIKFINITY_CAPTURED'],
  ['6090', 'Fireworks', 1088], ['7467', 'Chasing the Dream', 1500],
  ['6862', 'Cooper Flies Home', 1999], ['17762', 'Party Bus', 2999],
  ['6563', 'Meteor Shower', 3000], ['5767', 'Private Jet', 4888],
  ['6646', 'Leon the Kitten', 4888, 'TIKFINITY_CAPTURED'],
  ['14769', 'Hero Spaceship', 4999], ['9500', 'Flying Jets', 5000],
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

export function englishGiftName(giftId?: string, capturedName?: string): string {
  const verified = giftId ? verifiedById.get(giftId)?.name : undefined;
  if (verified) return verified;
  const normalized = capturedName?.trim() ?? '';
  if (normalized && /^[\x20-\x7E]+$/.test(normalized)) return normalized;
  return giftId ? `TikTok Gift ${giftId}` : 'TikTok Gift';
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
