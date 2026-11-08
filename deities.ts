// 5E 牧师可以选的神祇（被遗忘的国度 + 非人类神祇，只用于角色卡上的信仰说明）。
export type DeityData = { key: string; name: string; category: 'faerun' | 'nonhuman' };

const FAERUN = [
  '欧吕尔',
  '阿祖斯',
  '班恩',
  '本莎芭',
  '巴尔',
  '裳提亚',
  '希瑞克',
  '迪尼尔',
  '埃达丝',
  '贡德',
  '海姆',
  '伊尔梅特',
  '凯兰沃',
  '洛山达',
  '莱拉',
  '黎尔拉',
  '劳薇艾塔',
  '玛拉',
  '马斯克',
  '梅丽凯',
  '密里耳',
  '米尔寇',
  '密斯特拉',
  '欧格玛',
  '萨弗拉斯',
  '塞伦涅',
  '莎尔',
  '西凡那斯',
  '淑妮',
  '塔洛娜',
  '塔洛斯',
  '坦帕斯',
  '托姆',
  '泰摩拉',
  '提尔',
  '安博里',
  '渥金',
];

const NONHUMAN = [
  '巴哈姆特',
  '布里博杜普',
  '柯瑞隆·拉瑞斯安',
  '深海·赛悉拉',
  '依卓洛',
  '加尔·闪金',
  '葛洛蓝托',
  '格乌什',
  '赫鲁格克',
  '库图马克',
  '劳格兹得',
  '罗丝',
  '玛格鲁比耶',
  '摩拉丁',
  '瑞里芬·莱勒菲',
  '莎罕妮·月弓',
  '赛寇拉',
  '赛莫利亚',
  '斯凯里特',
  '司寇雷乌斯·岩骨',
  '苏尔特尔',
  '索列姆',
  '提亚玛特',
  '悠妲拉',
];

export const DEITIES: DeityData[] = [
  ...FAERUN.map((name, i) => ({ key: `fr-${i + 1}`, name, category: 'faerun' as const })),
  ...NONHUMAN.map((name, i) => ({ key: `nh-${i + 1}`, name, category: 'nonhuman' as const })),
];

export const DEITY_NAME: Record<string, string> = Object.fromEntries(DEITIES.map((d) => [d.key, d.name]));

export const DEITY_CATEGORY_LABEL: Record<DeityData['category'], string> = {
  faerun: '被遗忘的国度神祇',
  nonhuman: '非人类神祇',
};
