// 每个版本自带的剧本文件（scenarios 文件夹里）。升级时不复制它们（新版本里有新的），管理页里它们只能下架、不能删除。
// 别的剧本文件是自己放进去的、或者在管理页上传的：升级时复制到新版本，管理页里可以删除。
// V0.7.0：五个分区各两个，再加五个地下城，一共十五个，都用规则第二版。V0.9.0 加了一个 5E 入门模组《雾岭哑钟》。
export const BUILTIN_SCENARIO_FILES = [
  'qingxi-lantern-night.json',
  'opera-house-last-night.json',
  'yakou-fifth-man.json',
  'paper-effigy-shop.json',
  'border-town-siege.json',
  'heifeng-ridge-escort.json',
  'cliff-herb-moon.json',
  'desert-camel-bells.json',
  'mengzhu-ling.json',
  'teahouse-truce.json',
  'dungeon-abandoned-mine.json',
  'dungeon-sunken-fort.json',
  'dungeon-foxfire-manor.json',
  'dungeon-general-tomb.json',
  'dungeon-demon-tower.json',
  'mistridge-silent-bell.json',
];

// 以前的版本自带、现在不再带的剧本文件：升级时也不复制（不然会被当成自己放进去的剧本搬到新版本）。
// fog-harbor-inn.json 是阶段 1 写来测试的《雾港旅店》，V0.3.0 起只留在 test/fixtures 里给自动测试和测试数据用。
export const RETIRED_SCENARIO_FILES = ['fog-harbor-inn.json'];
