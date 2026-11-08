// 自动生成的文件（SRD 5.2.1 数据 + 本站的中文译文），不要手改。
import type { ClassData, FeatureText, OptionData, SubclassData } from '../../../shared/5e/types';

export const CLASSES: ClassData[] = [
 {
  "key": "barbarian",
  "name": "野蛮人",
  "text": "野蛮人是凭原始怒火作战的猛士，常常来自荒野或文明的边缘。他们能进入狂暴，硬扛刀剑、挥出势大力沉的重击，是冲在最前面的狠角色。主要属性是力量。",
  "hitDie": 12,
  "primary": [
   "str"
  ],
  "saves": [
   "str",
   "con"
  ],
  "armor": [
   "light",
   "medium",
   "shield"
  ],
  "weapons": [
   "simple",
   "martial"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "animal-handling",
   "athletics",
   "intimidation",
   "nature",
   "perception",
   "survival"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "greataxe",
      "qty": 1
     },
     {
      "key": "handaxe",
      "qty": 4
     },
     {
      "key": "explorers-pack",
      "qty": 1
     }
    ],
    "money": 1500
   },
   {
    "label": "B",
    "items": [],
    "money": 7500
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）巨斧、4 把手斧、探险家套组和 15 金币；或（B）75 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "barbarian-rage",
     "barbarian-unarmored-defense",
     "barbarian-weapon-mastery"
    ]
   },
   {
    "level": 2,
    "features": [
     "barbarian-danger-sense",
     "barbarian-reckless-attack"
    ]
   },
   {
    "level": 3,
    "features": [
     "barbarian-subclass",
     "barbarian-primal-knowledge"
    ]
   },
   {
    "level": 4,
    "features": [
     "barbarian-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "barbarian-extra-attack",
     "barbarian-fast-movement"
    ]
   },
   {
    "level": 6,
    "features": [
     "barbarian-path-feature"
    ]
   },
   {
    "level": 7,
    "features": [
     "barbarian-feral-instinct"
    ]
   },
   {
    "level": 8,
    "features": [
     "barbarian-ability-score-improvement"
    ]
   },
   {
    "level": 9,
    "features": [
     "barbarian-brutal-critical-1"
    ]
   },
   {
    "level": 10,
    "features": [
     "barbarian-path-feature"
    ]
   },
   {
    "level": 11,
    "features": [
     "barbarian-relentless-rage"
    ]
   },
   {
    "level": 12,
    "features": [
     "barbarian-ability-score-improvement"
    ]
   },
   {
    "level": 13,
    "features": [
     "barbarian-brutal-critical-2"
    ]
   },
   {
    "level": 14,
    "features": [
     "barbarian-path-feature"
    ]
   },
   {
    "level": 15,
    "features": [
     "barbarian-persistent-rage"
    ]
   },
   {
    "level": 16,
    "features": [
     "barbarian-ability-score-improvement"
    ]
   },
   {
    "level": 17,
    "features": [
     "barbarian-brutal-critical-3"
    ]
   },
   {
    "level": 18,
    "features": [
     "barbarian-indomitable-might"
    ]
   },
   {
    "level": 19,
    "features": [
     "barbarian-ability-score-improvement"
    ]
   },
   {
    "level": 20,
    "features": [
     "barbarian-primal-champion"
    ]
   }
  ],
  "spellcasting": null
 },
 {
  "key": "bard",
  "name": "吟游诗人",
  "text": "吟游诗人用言语、音乐和舞蹈编织魔法，是能鼓舞同伴、扰乱敌人的多面手。他们博闻多识、样样都会一点，既能施法治疗和辅助，也能在社交场合大显身手。主要属性是魅力。",
  "hitDie": 8,
  "primary": [
   "cha"
  ],
  "saves": [
   "dex",
   "cha"
  ],
  "armor": [
   "light"
  ],
  "weapons": [
   "simple"
  ],
  "tools": [
   "musical-instrument"
  ],
  "skillCount": 3,
  "skillOptions": [
   "acrobatics",
   "animal-handling",
   "arcana",
   "athletics",
   "deception",
   "history",
   "insight",
   "intimidation",
   "investigation",
   "medicine",
   "nature",
   "perception",
   "performance",
   "persuasion",
   "religion",
   "sleight-of-hand",
   "stealth",
   "survival"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "leather-armor",
      "qty": 1
     },
     {
      "key": "dagger",
      "qty": 2
     },
     {
      "key": "lute",
      "qty": 1
     },
     {
      "key": "entertainers-pack",
      "qty": 1
     }
    ],
    "money": 1900
   },
   {
    "label": "B",
    "items": [],
    "money": 9000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）皮甲、2 把匕首、一件你选择的乐器、艺人套组和 19 金币；或（B）90 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "bard-bardic-inspiration",
     "bard-spellcasting"
    ]
   },
   {
    "level": 2,
    "features": [
     "bard-jack-of-all-trades",
     "bard-song-of-rest-1"
    ]
   },
   {
    "level": 3,
    "features": [
     "bard-expertise",
     "bard-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "bard-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "bard-font-of-inspiration"
    ]
   },
   {
    "level": 6,
    "features": [
     "bard-countercharm"
    ]
   },
   {
    "level": 8,
    "features": [
     "bard-ability-score-improvement"
    ]
   },
   {
    "level": 9,
    "features": [
     "bard-song-of-rest-2"
    ]
   },
   {
    "level": 10,
    "features": [
     "bard-expertise-2",
     "bard-magical-secrets-1"
    ]
   },
   {
    "level": 14,
    "features": [
     "bard-magical-secrets-2"
    ]
   },
   {
    "level": 12,
    "features": [
     "bard-ability-score-improvement"
    ]
   },
   {
    "level": 13,
    "features": [
     "bard-song-of-rest-3"
    ]
   },
   {
    "level": 16,
    "features": [
     "bard-ability-score-improvement"
    ]
   },
   {
    "level": 17,
    "features": [
     "bard-song-of-rest-4"
    ]
   },
   {
    "level": 18,
    "features": [
     "bard-magical-secrets-3"
    ]
   },
   {
    "level": 19,
    "features": [
     "bard-ability-score-improvement"
    ]
   },
   {
    "level": 20,
    "features": [
     "bard-superior-inspiration"
    ]
   }
  ],
  "spellcasting": {
   "ability": "cha",
   "kind": "full",
   "cantrips": [
    2,
    2,
    2,
    3,
    3
   ],
   "prepared": [
    4,
    5,
    6,
    7,
    9
   ]
  }
 },
 {
  "key": "cleric",
  "name": "牧师",
  "text": "牧师是神祇在凡间的代言人，通过祈祷和冥想引来神圣魔法。他们擅长治疗和守护同伴，也能借神力惩戒敌人、驱散不死生物，有的还身披重甲站在前线。主要属性是感知。",
  "hitDie": 8,
  "primary": [
   "wis"
  ],
  "saves": [
   "wis",
   "cha"
  ],
  "armor": [
   "light",
   "medium",
   "shield"
  ],
  "weapons": [
   "simple"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "history",
   "insight",
   "medicine",
   "persuasion",
   "religion"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "chain-shirt",
      "qty": 1
     },
     {
      "key": "shield",
      "qty": 1
     },
     {
      "key": "mace",
      "qty": 1
     },
     {
      "key": "amulet",
      "qty": 1
     },
     {
      "key": "priests-pack",
      "qty": 1
     }
    ],
    "money": 700
   },
   {
    "label": "B",
    "items": [],
    "money": 11000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）链甲衫、盾牌、硬头锤、圣徽、祭司套组和 7 金币；或（B）110 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "cleric-divine-order",
     "cleric-spellcasting"
    ]
   },
   {
    "level": 2,
    "features": [
     "cleric-channel-divinity",
     "cleric-turn-undead"
    ]
   },
   {
    "level": 3,
    "features": [
     "cleric-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "cleric-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "cleric-destroy-undead-0"
    ]
   },
   {
    "level": 6,
    "features": [
     "cleric-channel-divinity",
     "cleric-domain-feature"
    ]
   },
   {
    "level": 8,
    "features": [
     "cleric-ability-score-improvement",
     "cleric-destroy-undead-1",
     "cleric-domain-feature"
    ]
   },
   {
    "level": 10,
    "features": [
     "cleric-divine-intervention"
    ]
   },
   {
    "level": 11,
    "features": [
     "cleric-destroy-undead-2"
    ]
   },
   {
    "level": 12,
    "features": [
     "cleric-ability-score-improvement"
    ]
   },
   {
    "level": 14,
    "features": [
     "cleric-destroy-undead-3"
    ]
   },
   {
    "level": 16,
    "features": [
     "cleric-ability-score-improvement"
    ]
   },
   {
    "level": 17,
    "features": [
     "cleric-destroy-undead-4",
     "cleric-domain-feature"
    ]
   },
   {
    "level": 18,
    "features": [
     "cleric-channel-divinity"
    ]
   },
   {
    "level": 19,
    "features": [
     "cleric-ability-score-improvement"
    ]
   },
   {
    "level": 20,
    "features": [
     "cleric-divine-intervention-improved"
    ]
   }
  ],
  "spellcasting": {
   "ability": "wis",
   "kind": "full",
   "cantrips": [
    3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5
   ],
   "prepared": [
    4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24
   ]
  }
 },
 {
  "key": "druid",
  "name": "德鲁伊",
  "text": "德鲁伊是守护自然的祭司和贤者，从自然的原初之力中汲取魔法。他们能与动物沟通、化身为野兽，也能呼唤风雷、火焰与草木的力量。主要属性是感知。",
  "hitDie": 8,
  "primary": [
   "wis"
  ],
  "saves": [
   "int",
   "wis"
  ],
  "armor": [
   "light",
   "shield"
  ],
  "weapons": [
   "simple"
  ],
  "tools": [
   "herbalism-kit"
  ],
  "skillCount": 2,
  "skillOptions": [
   "arcana",
   "animal-handling",
   "insight",
   "medicine",
   "nature",
   "perception",
   "religion",
   "survival"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "leather-armor",
      "qty": 1
     },
     {
      "key": "shield",
      "qty": 1
     },
     {
      "key": "sickle",
      "qty": 1
     },
     {
      "key": "quarterstaff",
      "qty": 1
     },
     {
      "key": "explorers-pack",
      "qty": 1
     },
     {
      "key": "herbalism-kit",
      "qty": 1
     }
    ],
    "money": 900
   },
   {
    "label": "B",
    "items": [],
    "money": 5000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）皮甲、盾牌、镰刀、德鲁伊法器（长棍）、探险家套组、草药工具和 9 金币；或（B）50 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "druid-druidic",
     "druid-primal-order",
     "druid-spellcasting"
    ]
   },
   {
    "level": 2,
    "features": [
     "druid-wild-shape",
     "druid-wild-companion"
    ]
   },
   {
    "level": 3,
    "features": [
     "druid-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "druid-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "druid-wild-resurgence"
    ]
   }
  ],
  "spellcasting": {
   "ability": "wis",
   "kind": "full",
   "cantrips": [
    2,
    2,
    2,
    3,
    3
   ],
   "prepared": [
    4,
    5,
    6,
    7,
    9
   ]
  }
 },
 {
  "key": "fighter",
  "name": "战士",
  "text": "精通各种武器和护甲的战斗专家，可能是骑士、佣兵、老兵或角斗士。他们靠千锤百炼的武艺和过人的耐力取胜，能在关键时刻爆发出连续的攻势，是队伍里最可靠的中坚。主要属性是力量或敏捷。",
  "hitDie": 10,
  "primary": [
   "str",
   "dex"
  ],
  "saves": [
   "str",
   "con"
  ],
  "armor": [
   "light",
   "medium",
   "heavy",
   "shield"
  ],
  "weapons": [
   "simple",
   "martial"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "acrobatics",
   "animal-handling",
   "athletics",
   "history",
   "insight",
   "intimidation",
   "persuasion",
   "perception",
   "survival"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "chain-mail",
      "qty": 1
     },
     {
      "key": "greatsword",
      "qty": 1
     },
     {
      "key": "flail",
      "qty": 1
     },
     {
      "key": "javelin",
      "qty": 8
     },
     {
      "key": "dungeoneer-pack",
      "qty": 1
     }
    ],
    "money": 400
   },
   {
    "label": "B",
    "items": [
     {
      "key": "studded-leather-armor",
      "qty": 1
     },
     {
      "key": "scimitar",
      "qty": 1
     },
     {
      "key": "shortsword",
      "qty": 1
     },
     {
      "key": "longbow",
      "qty": 1
     },
     {
      "key": "arrows",
      "qty": 20
     },
     {
      "key": "quiver",
      "qty": 1
     },
     {
      "key": "dungeoneer-pack",
      "qty": 1
     }
    ],
    "money": 1100
   },
   {
    "label": "C",
    "items": [],
    "money": 15500
   }
  ],
  "equipmentText": "从下面三套里选一套：（A）链甲、巨剑、链枷、8 支标枪、地城探索套组和 4 金币；（B）镶钉皮甲、弯刀、短剑、长弓、20 支箭、箭袋、地城探索套组和 11 金币；或（C）155 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "fighter-fighting-style",
     "fighter-second-wind",
     "fighter-weapon-mastery"
    ]
   },
   {
    "level": 2,
    "features": [
     "fighter-action-surge",
     "fighter-tactical-mind"
    ]
   },
   {
    "level": 3,
    "features": [
     "fighter-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "fighter-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "fighter-extra-attack",
     "fighter-tactical-shift"
    ]
   }
  ],
  "spellcasting": null
 },
 {
  "key": "monk",
  "name": "武僧",
  "text": "武僧是修炼身心的武者，把体内的能量化为功力，用拳脚和简单的武器迅疾出击。他们不穿护甲也能凭身法闪避攻击，行动如风、出手如电。主要属性是敏捷和感知。",
  "hitDie": 8,
  "primary": [
   "dex",
   "wis"
  ],
  "saves": [
   "str",
   "dex"
  ],
  "armor": [],
  "weapons": [
   "simple",
   "martial-light"
  ],
  "tools": [
   "artisans-tools-or-instrument"
  ],
  "skillCount": 2,
  "skillOptions": [
   "acrobatics",
   "athletics",
   "history",
   "insight",
   "religion",
   "stealth"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "spear",
      "qty": 1
     },
     {
      "key": "dagger",
      "qty": 5
     },
     {
      "key": "flute",
      "qty": 1
     },
     {
      "key": "explorers-pack",
      "qty": 1
     }
    ],
    "money": 1100
   },
   {
    "label": "B",
    "items": [],
    "money": 5000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）矛、5 把匕首、一套工匠工具或一件乐器（就是你在上面的工具熟练里选的那一种）、探险家套组和 11 金币；或（B）50 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "monk-martial-arts",
     "monk-unarmored-defense"
    ]
   },
   {
    "level": 2,
    "features": [
     "monk-monks-focus",
     "monk-unarmored-movement",
     "monk-uncanny-metabolism"
    ]
   },
   {
    "level": 3,
    "features": [
     "monk-subclass",
     "monk-deflect-attacks"
    ]
   },
   {
    "level": 4,
    "features": [
     "monk-ability-score-improvement",
     "monk-slow-fall"
    ]
   },
   {
    "level": 5,
    "features": [
     "monk-extra-attack",
     "monk-stunning-strike"
    ]
   }
  ],
  "spellcasting": null
 },
 {
  "key": "paladin",
  "name": "圣武士",
  "text": "圣武士是立下神圣誓言的战士，以誓言之力对抗邪恶、守护弱者。他们身披重甲冲在前线，既能用神圣之力重创敌人，也能以圣疗治愈伤者。主要属性是力量和魅力。",
  "hitDie": 10,
  "primary": [
   "str",
   "cha"
  ],
  "saves": [
   "wis",
   "cha"
  ],
  "armor": [
   "light",
   "medium",
   "heavy",
   "shield"
  ],
  "weapons": [
   "simple",
   "martial"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "athletics",
   "insight",
   "intimidation",
   "medicine",
   "persuasion",
   "religion"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "chain-mail",
      "qty": 1
     },
     {
      "key": "shield",
      "qty": 1
     },
     {
      "key": "longsword",
      "qty": 1
     },
     {
      "key": "javelin",
      "qty": 6
     },
     {
      "key": "amulet",
      "qty": 1
     },
     {
      "key": "priests-pack",
      "qty": 1
     }
    ],
    "money": 900
   },
   {
    "label": "B",
    "items": [],
    "money": 15000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）链甲、盾牌、长剑、6 支标枪、圣徽、祭司套组和 9 金币；或（B）150 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "paladin-lay-on-hands",
     "paladin-spellcasting",
     "paladin-weapon-mastery"
    ]
   },
   {
    "level": 2,
    "features": [
     "paladin-fighting-style",
     "paladin-paladins-smite"
    ]
   },
   {
    "level": 3,
    "features": [
     "paladin-channel-divinity",
     "paladin-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "paladin-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "paladin-extra-attack",
     "paladin-faithful-steed"
    ]
   }
  ],
  "spellcasting": {
   "ability": "cha",
   "kind": "half",
   "cantrips": [
    0,
    0,
    0,
    0,
    0
   ],
   "prepared": [
    2,
    3,
    4,
    5,
    6
   ]
  }
 },
 {
  "key": "ranger",
  "name": "游侠",
  "text": "游侠是游走在荒野与文明边缘的猎手和斥候，擅长追踪、求生和弓箭作战。他们借助自然的魔法标记猎物、穿越险地，守护边境免受威胁。主要属性是敏捷和感知。",
  "hitDie": 10,
  "primary": [
   "dex",
   "wis"
  ],
  "saves": [
   "str",
   "dex"
  ],
  "armor": [
   "light",
   "medium",
   "shield"
  ],
  "weapons": [
   "simple",
   "martial"
  ],
  "tools": [],
  "skillCount": 3,
  "skillOptions": [
   "animal-handling",
   "athletics",
   "insight",
   "investigation",
   "nature",
   "perception",
   "stealth",
   "survival"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "studded-leather-armor",
      "qty": 1
     },
     {
      "key": "scimitar",
      "qty": 1
     },
     {
      "key": "shortsword",
      "qty": 1
     },
     {
      "key": "longbow",
      "qty": 1
     },
     {
      "key": "arrows",
      "qty": 20
     },
     {
      "key": "quiver",
      "qty": 1
     },
     {
      "key": "sprig-of-mistletoe",
      "qty": 1
     },
     {
      "key": "explorers-pack",
      "qty": 1
     }
    ],
    "money": 700
   },
   {
    "label": "B",
    "items": [],
    "money": 15000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）镶钉皮甲、弯刀、短剑、长弓、20 支箭、箭袋、德鲁伊法器（一枝槲寄生）、探险家套组和 7 金币；或（B）150 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "ranger-favored-enemy",
     "ranger-spellcasting",
     "ranger-weapon-mastery"
    ]
   },
   {
    "level": 2,
    "features": [
     "ranger-deft-explorer",
     "ranger-fighting-style"
    ]
   },
   {
    "level": 3,
    "features": [
     "ranger-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "ranger-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "ranger-extra-attack"
    ]
   }
  ],
  "spellcasting": {
   "ability": "wis",
   "kind": "half",
   "cantrips": [
    0,
    0,
    0,
    0,
    0
   ],
   "prepared": [
    2,
    3,
    4,
    5,
    6
   ]
  }
 },
 {
  "key": "rogue",
  "name": "游荡者",
  "text": "游荡者靠机巧和身手过活，是开锁、潜行、解除陷阱的行家。他们善于抓住敌人的破绽给予致命一击，也能在危险中灵活脱身。主要属性是敏捷。",
  "hitDie": 8,
  "primary": [
   "dex"
  ],
  "saves": [
   "dex",
   "int"
  ],
  "armor": [
   "light"
  ],
  "weapons": [
   "simple",
   "martial-finesse-light"
  ],
  "tools": [
   "thieves-tools"
  ],
  "skillCount": 4,
  "skillOptions": [
   "acrobatics",
   "athletics",
   "deception",
   "insight",
   "intimidation",
   "investigation",
   "perception",
   "persuasion",
   "sleight-of-hand",
   "stealth"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "leather-armor",
      "qty": 1
     },
     {
      "key": "dagger",
      "qty": 2
     },
     {
      "key": "shortsword",
      "qty": 1
     },
     {
      "key": "shortbow",
      "qty": 1
     },
     {
      "key": "arrows",
      "qty": 20
     },
     {
      "key": "quiver",
      "qty": 1
     },
     {
      "key": "thieves-tools",
      "qty": 1
     },
     {
      "key": "burglars-pack",
      "qty": 1
     }
    ],
    "money": 800
   },
   {
    "label": "B",
    "items": [],
    "money": 10000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）皮甲、2 把匕首、短剑、短弓、20 支箭、箭袋、盗贼工具、窃贼套组和 8 金币；或（B）100 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "rogue-expertise",
     "rogue-sneak-attack",
     "rogue-thieves-cant",
     "rogue-weapon-mastery"
    ]
   },
   {
    "level": 2,
    "features": [
     "rogue-cunning-action"
    ]
   },
   {
    "level": 3,
    "features": [
     "rogue-subclass",
     "rogue-steady-aim"
    ]
   },
   {
    "level": 4,
    "features": [
     "rogue-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "rogue-cunning-strike",
     "rogue-uncanny-dodge"
    ]
   }
  ],
  "spellcasting": null
 },
 {
  "key": "sorcerer",
  "name": "术士",
  "text": "术士的魔法与生俱来，源自血脉、天赋或某次奇遇，而不是苦读或契约。他们能用体内的术法之力随心改造法术，让魔法发挥出意想不到的效果。主要属性是魅力。",
  "hitDie": 6,
  "primary": [
   "cha"
  ],
  "saves": [
   "con",
   "cha"
  ],
  "armor": [],
  "weapons": [
   "simple"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "arcana",
   "deception",
   "insight",
   "intimidation",
   "persuasion",
   "religion"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "spear",
      "qty": 1
     },
     {
      "key": "dagger",
      "qty": 2
     },
     {
      "key": "crystal",
      "qty": 1
     },
     {
      "key": "dungeoneer-pack",
      "qty": 1
     }
    ],
    "money": 2800
   },
   {
    "label": "B",
    "items": [],
    "money": 5000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）矛、2 把匕首、奥术法器（水晶）、地城探索套组和 28 金币；或（B）50 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "sorcerer-innate-sorcery",
     "sorcerer-spellcasting"
    ]
   },
   {
    "level": 2,
    "features": [
     "sorcerer-font-of-magic",
     "sorcerer-metamagic"
    ]
   },
   {
    "level": 3,
    "features": [
     "sorcerer-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "sorcerer-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "sorcerer-sorcerous-restoration"
    ]
   }
  ],
  "spellcasting": {
   "ability": "cha",
   "kind": "full",
   "cantrips": [
    4,
    4,
    4,
    5,
    5
   ],
   "prepared": [
    2,
    4,
    6,
    7,
    9
   ]
  }
 },
 {
  "key": "warlock",
  "name": "邪术师",
  "text": "邪术师通过与强大的异界存在缔结契约获得魔法，宗主可能是邪魔、精类或更难以名状的存在。他们掌握魔能祈唤这类禁忌秘术，用宗主赐予的力量施法。主要属性是魅力。",
  "hitDie": 8,
  "primary": [
   "cha"
  ],
  "saves": [
   "wis",
   "cha"
  ],
  "armor": [
   "light"
  ],
  "weapons": [
   "simple"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "arcana",
   "deception",
   "history",
   "intimidation",
   "investigation",
   "nature",
   "religion"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "leather-armor",
      "qty": 1
     },
     {
      "key": "sickle",
      "qty": 1
     },
     {
      "key": "dagger",
      "qty": 2
     },
     {
      "key": "orb",
      "qty": 1
     },
     {
      "key": "book",
      "qty": 1
     },
     {
      "key": "scholars-pack",
      "qty": 1
     }
    ],
    "money": 1500
   },
   {
    "label": "B",
    "items": [],
    "money": 10000
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）皮甲、镰刀、2 把匕首、奥术法器（宝珠）、书、学者套组和 15 金币；或（B）100 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "warlock-eldritch-invocations",
     "warlock-pact-magic"
    ]
   },
   {
    "level": 2,
    "features": [
     "warlock-magical-cunning"
    ]
   },
   {
    "level": 3,
    "features": [
     "warlock-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "warlock-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": []
   }
  ],
  "spellcasting": {
   "ability": "cha",
   "kind": "pact",
   "cantrips": [
    2,
    2,
    2,
    3,
    3
   ],
   "prepared": [
    2,
    3,
    4,
    5,
    6
   ]
  }
 },
 {
  "key": "wizard",
  "name": "法师",
  "text": "法师是钻研奥术的学者，通过苦读和实验掌握魔法，并把学到的法术记在法术书里。他们能学会的法术种类繁多，从元素轰炸到占卜幻术无所不包。主要属性是智力。",
  "hitDie": 6,
  "primary": [
   "int"
  ],
  "saves": [
   "int",
   "wis"
  ],
  "armor": [],
  "weapons": [
   "simple"
  ],
  "tools": [],
  "skillCount": 2,
  "skillOptions": [
   "arcana",
   "history",
   "insight",
   "investigation",
   "medicine",
   "nature",
   "religion"
  ],
  "equipment": [
   {
    "label": "A",
    "items": [
     {
      "key": "dagger",
      "qty": 2
     },
     {
      "key": "quarterstaff",
      "qty": 1
     },
     {
      "key": "robe",
      "qty": 1
     },
     {
      "key": "spellbook",
      "qty": 1
     },
     {
      "key": "scholars-pack",
      "qty": 1
     }
    ],
    "money": 500
   },
   {
    "label": "B",
    "items": [],
    "money": 5500
   }
  ],
  "equipmentText": "从下面两套里选一套：（A）2 把匕首、奥术法器（长棍）、长袍、法术书、学者套组和 5 金币；或（B）55 金币。",
  "levels": [
   {
    "level": 1,
    "features": [
     "wizard-arcane-recovery",
     "wizard-ritual-adept",
     "wizard-spellcasting"
    ]
   },
   {
    "level": 2,
    "features": [
     "wizard-scholar"
    ]
   },
   {
    "level": 3,
    "features": [
     "wizard-subclass"
    ]
   },
   {
    "level": 4,
    "features": [
     "wizard-ability-score-improvement"
    ]
   },
   {
    "level": 5,
    "features": [
     "wizard-memorize-spell"
    ]
   }
  ],
  "spellcasting": {
   "ability": "int",
   "kind": "full",
   "cantrips": [
    3,
    3,
    3,
    4,
    4
   ],
   "prepared": [
    4,
    5,
    6,
    7,
    9
   ]
  }
 }
];

export const SUBCLASSES: SubclassData[] = [
 {
  "key": "path-of-the-berserker",
  "class": "barbarian",
  "name": "狂战士道途",
  "text": "走狂战士道途的野蛮人主要把狂暴倾注于暴力。他们的道路是不受约束的狂怒，他们任由狂暴攫住自己、给予自己力量，在混乱的战斗中尽情享受那份刺激。",
  "features": [
   {
    "level": 3,
    "key": "berserker-frenzy"
   },
   {
    "level": 6,
    "key": "berserker-mindless-rage"
   },
   {
    "level": 10,
    "key": "berserker-intimidating-presence"
   },
   {
    "level": 14,
    "key": "berserker-retaliation"
   }
  ]
 },
 {
  "key": "path-of-the-totem-warrior",
  "class": "barbarian",
  "name": "图腾武者道途",
  "text": "图腾武者道途是灵魂修炼的旅途。走上此道的野蛮人以一种兽魂作为其向导、保护者和力量源泉。在战斗中，你的图腾精魄将超自然的力量灌输于你，为你的狂暴注入魔法力量。大多数野蛮人部族将图腾兽视为氏族的一员，因此很少有人同时拥有两种或更多图腾精魄，但这样的特例依然存在。",
  "features": [
   {
    "level": 3,
    "key": "totem-spirit-seeker"
   },
   {
    "level": 3,
    "key": "totem-spirit"
   },
   {
    "level": 6,
    "key": "totem-aspect-of-the-beast"
   },
   {
    "level": 10,
    "key": "totem-spirit-walker"
   },
   {
    "level": 14,
    "key": "totem-totemic-attunement"
   }
  ]
 },
 {
  "key": "college-of-lore",
  "class": "bard",
  "name": "逸闻学院",
  "text": "逸闻学院的吟游诗人从各种来源搜集法术和秘密，比如学术典籍、神秘仪式和乡野传说。学院成员聚集在图书馆和大学里互相分享学识；他们也会出现在节庆或国事场合，在那里揭露腐败、拆穿谎言、嘲弄自以为是的权贵。",
  "features": [
   {
    "level": 3,
    "key": "lore-bonus-proficiencies"
   },
   {
    "level": 3,
    "key": "lore-cutting-words"
   },
   {
    "level": 6,
    "key": "lore-additional-magical-secrets"
   },
   {
    "level": 14,
    "key": "lore-peerless-skill"
   }
  ]
 },
 {
  "key": "college-of-valor",
  "class": "bard",
  "name": "勇气学院",
  "text": "勇气学院是那些怀念逝去英雄的歌者聚集之地，也是新英雄诗篇的诞生地。诗人们或汇聚在金色大厅里，或围坐在熊熊篝火旁，颂唱着古往今来那些英勇事迹。他们行走大陆亲身见识体验那些伟大的事件，确保那些值得记忆的事不会被世界所遗忘。他们以激昂的诗歌激励旁人，向着英雄们的道路不倦的前进。",
  "features": [
   {
    "level": 3,
    "key": "valor-bonus-proficiencies"
   },
   {
    "level": 3,
    "key": "valor-combat-inspiration"
   },
   {
    "level": 6,
    "key": "valor-extra-attack"
   },
   {
    "level": 14,
    "key": "valor-battle-magic"
   }
  ]
 },
 {
  "key": "life-domain",
  "class": "cleric",
  "name": "生命领域",
  "text": "生命领域专注于维系多元宇宙中一切生命的正能量。汲取这一领域力量的牧师是治疗大师，用这股生命之力治愈种种伤痛。\n存在本身就依赖与这一领域相关的正能量，所以几乎任何宗教传统的牧师都可能选择它。这一领域尤其与农业之神、治疗或坚忍之神、家园与社群之神相关。专司治疗的宗教团体也会追求这一领域的魔法。",
  "features": [
   {
    "level": 3,
    "key": "life-disciple-of-life"
   },
   {
    "level": 3,
    "key": "life-domain-spells"
   },
   {
    "level": 3,
    "key": "life-preserve-life"
   }
  ]
 },
 {
  "key": "circle-of-the-land",
  "class": "druid",
  "name": "大地结社",
  "text": "大地结社由守护古老知识和仪式的神秘主义者和贤者组成。这些德鲁伊在神圣的树环或巨石阵中聚会，用德鲁伊语低诵原初的秘密。结社中最睿智的成员担任所在社群的大祭司。",
  "features": [
   {
    "level": 3,
    "key": "land-circle-of-the-land-spells"
   },
   {
    "level": 3,
    "key": "land-lands-aid"
   }
  ]
 },
 {
  "key": "champion",
  "class": "fighter",
  "name": "勇士",
  "text": "勇士专注于锤炼武艺，不懈地追求胜利。勇士把严格的训练和出众的体魄结合起来，打出毁灭性的攻击、挺过种种危险、赢得荣耀。无论是在竞技比赛中还是在血腥的战场上，勇士都力争夺得胜利者的桂冠。",
  "features": [
   {
    "level": 3,
    "key": "champion-improved-critical"
   },
   {
    "level": 3,
    "key": "champion-remarkable-athlete"
   }
  ]
 },
 {
  "key": "warrior-of-the-open-hand",
  "class": "monk",
  "name": "散打武者",
  "text": "散打武者是徒手格斗的大师。他们学会推开和绊倒对手的技巧，并能操控自身的能量保护自己免受伤害。",
  "features": [
   {
    "level": 3,
    "key": "open-hand-technique"
   }
  ]
 },
 {
  "key": "oath-of-devotion",
  "class": "paladin",
  "name": "奉献之誓",
  "text": "奉献之誓让圣武士恪守正义与秩序的理想。这些圣武士正是「闪亮铠甲骑士」这一形象的化身。他们以最高的行为准则要求自己，有些人还——无论好坏——用同样的标准要求世上其他所有人。\n许多立下此誓的人信奉守序与善良的神祇，以神祇的教义衡量自己的虔诚；也有人以天使为理想，把天使之翼的图案融入自己的头盔或纹章。\n这些圣武士共同信守以下信条：\n- 言出必践。\n- 保护弱者，行事无惧。\n- 以荣誉之举为人表率。",
  "features": [
   {
    "level": 3,
    "key": "devotion-oath-of-devotion-spells"
   },
   {
    "level": 3,
    "key": "devotion-sacred-weapon"
   }
  ]
 },
 {
  "key": "hunter",
  "class": "ranger",
  "name": "猎人",
  "text": "你在荒野和其他地方追猎猎物，运用身为猎人的本领，保护自然和各地的人们免受那些意欲毁灭它们的力量侵害。",
  "features": [
   {
    "level": 3,
    "key": "hunter-hunters-lore"
   },
   {
    "level": 3,
    "key": "hunter-hunters-prey"
   }
  ]
 },
 {
  "key": "thief",
  "class": "rogue",
  "name": "窃贼",
  "text": "你集窃贼、寻宝者和探险家于一身，是冒险者的典范。除了身手更加敏捷、更善于潜行之外，你还会获得一些本领，帮助你深入遗迹探险，并充分利用在那里找到的魔法物品。",
  "features": [
   {
    "level": 3,
    "key": "thief-fast-hands"
   },
   {
    "level": 3,
    "key": "thief-second-story-work"
   }
  ]
 },
 {
  "key": "draconic-sorcery",
  "class": "sorcerer",
  "name": "龙族术法",
  "text": "你的天生魔法来自龙的馈赠。也许是一条垂死的古龙把部分魔力传给了你或你的祖先；也许你从一处充满龙之力量的地方吸收了魔法；也许你接触过一件从龙的宝藏中取出、浸透了龙之力量的珍宝；又或者你的祖先之中就有龙。",
  "features": [
   {
    "level": 3,
    "key": "draconic-sorcery-draconic-resilience"
   },
   {
    "level": 3,
    "key": "draconic-sorcery-draconic-spells"
   }
  ]
 },
 {
  "key": "fiend-patron",
  "class": "warlock",
  "name": "邪魔宗主",
  "text": "你的契约汲取自下层位面，也就是那些永劫之地。你可能与一位恶魔领主、一位大魔鬼或其他格外强大的邪魔达成了交易。这位宗主的目的是邪恶的——腐化或毁灭万物，最终也包括你——而你的道路取决于你在多大程度上与这些目的相抗衡。",
  "features": [
   {
    "level": 3,
    "key": "fiend-patron-dark-ones-blessing"
   },
   {
    "level": 3,
    "key": "fiend-patron-fiend-spells"
   }
  ]
 },
 {
  "key": "evoker",
  "class": "wizard",
  "name": "塑能师",
  "text": "你的研究专注于能制造强大元素效果的魔法，比如刺骨的严寒、灼热的火焰、隆隆的雷鸣、噼啪作响的闪电和腐蚀的强酸。有些塑能师受雇于军队，充当从远处轰击敌军的炮兵；另一些人用自己的力量保护他人，还有些人则只图私利。",
  "features": [
   {
    "level": 3,
    "key": "evoker-evocation-savant"
   },
   {
    "level": 3,
    "key": "evoker-potent-cantrip"
   }
  ]
 }
];

export const FEATURES: Record<string, FeatureText> = {
 "barbarian-rage": {
  "key": "barbarian-rage",
  "name": "狂暴",
  "text": "你能让自己充满一种名为狂暴的原初力量，这股力量赋予你非凡的力气和韧性。只要你没有穿着重甲，你就能以一个附赠动作进入狂暴。\n你能进入狂暴的次数，见野蛮人特性表「狂暴次数」一栏中你的野蛮人等级所对应的数字。你完成一次短休时恢复一次已消耗的使用次数，完成一次长休时恢复所有已消耗的使用次数。\n狂暴持续期间遵循下列规则。\n伤害抗性。你对钝击、穿刺和挥砍伤害具有抗性。\n狂暴伤害。当你用力量进行攻击（无论用武器还是徒手打击）并对目标造成伤害时，你的这次伤害获得一个加值，这个加值随你的野蛮人等级提升而增加，见野蛮人特性表的「狂暴伤害」一栏。\n力量优势。你的力量检定和力量豁免具有优势。\n不能专注或施法。你无法维持专注，也无法施展法术。\n持续时间。狂暴持续到你的下个回合结束；如果你穿上重甲或陷入失能状态，狂暴会提前结束。如果你的狂暴在你的下个回合仍在持续，你可以通过下列任一方式让狂暴再延长一轮：\n- 对一个敌人进行一次攻击检定。\n- 迫使一个敌人进行一次豁免检定。\n- 用一个附赠动作延长狂暴。\n狂暴每延长一次，就持续到你的下个回合结束。你最多能维持狂暴 10 分钟。"
 },
 "barbarian-unarmored-defense": {
  "key": "barbarian-unarmored-defense",
  "name": "无甲防御",
  "text": "当你没有穿着任何护甲时，你的基础护甲等级等于 10 + 你的敏捷调整值 + 你的体质调整值。你使用盾牌时仍能获得这项好处。"
 },
 "barbarian-weapon-mastery": {
  "key": "barbarian-weapon-mastery",
  "name": "武器精通",
  "text": "你的武器训练让你能使用两种你选择的简易或军用近战武器的精通属性，比如巨斧和手斧。每当你完成一次长休时，你可以进行武器操练，并更换其中一种武器选择。\n当你达到特定的野蛮人等级时，你能使用更多种武器的精通属性，见野蛮人特性表的「武器精通」一栏。"
 },
 "barbarian-danger-sense": {
  "key": "barbarian-danger-sense",
  "name": "危险感知",
  "text": "你获得对周遭异常情况超乎寻常的感测力，让你能先一步脱离危险。在受到你能看见的效应（诸如陷阱和法术）影响时，你对其进行的敏捷豁免具有优势。你无法在目盲、耳聋或是失能的状态下从此特性获益。"
 },
 "barbarian-reckless-attack": {
  "key": "barbarian-reckless-attack",
  "name": "鲁莽攻击",
  "text": "第 2 级起，你可以抛弃一切防御的执念进行狂怒的攻击。你在自己回合内发动第一次攻击时，可以选择发动鲁莽攻击。使用此特性后，你本回合内所有使用力量值发动的近战武器攻击具有优势。此后，所有对你发动的攻击检定也将具有优势，且该优势持续存在至你的下个回合。"
 },
 "barbarian-subclass": {
  "key": "barbarian-subclass",
  "name": "野蛮人子职业",
  "text": "你获得一个你选择的野蛮人子职业。子职业是一种专精方向，会在特定的野蛮人等级给予你特性。在此后的冒险生涯中，凡是等级不高于你野蛮人等级的子职业特性，你都会获得。"
 },
 "barbarian-primal-knowledge": {
  "key": "barbarian-primal-knowledge",
  "name": "原初知识",
  "text": "你从野蛮人 1 级可选的技能列表中再选择一项技能，获得该技能的熟练。\n此外，当你的狂暴持续时，你在尝试某些事情时可以引导原初之力：每当你使用下列技能之一进行属性检定时，即使这项检定通常使用别的属性，你也可以把它当作力量检定来进行：体操、威吓、察觉、隐匿或求生。当你这样做时，你的力量代表着在你体内奔涌的原初之力，它磨砺着你的敏捷、气度和感官。"
 },
 "barbarian-ability-score-improvement": {
  "key": "barbarian-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "barbarian-extra-attack": {
  "key": "barbarian-extra-attack",
  "name": "额外攻击",
  "text": "每当你在自己的回合执行攻击动作时，你可以攻击两次，而不是一次。"
 },
 "barbarian-fast-movement": {
  "key": "barbarian-fast-movement",
  "name": "快速移动",
  "text": "当你没有穿着重甲时，你的速度增加 10 尺。"
 },
 "barbarian-path-feature": {
  "key": "barbarian-path-feature",
  "name": "道途特性",
  "text": "你获得所选原初道途的特性。具体能力见所选道途的说明。"
 },
 "barbarian-feral-instinct": {
  "key": "barbarian-feral-instinct",
  "name": "野性直觉",
  "text": "你的本能敏锐得惊人。你进行先攻检定时具有优势。\n另外，如果你在狂暴时被突袭，你可以在自己回合正常行动，前提是你在该回合结束前进入狂暴。如果你无法进入狂暴，你就不能这样做。"
 },
 "barbarian-brutal-critical-1": {
  "key": "barbarian-brutal-critical-1",
  "name": "凶蛮重击（1 骰）",
  "text": "当你用近战攻击造成重击时，你可以额外掷一枚武器伤害骰，并把结果加到这次重击的额外伤害里。"
 },
 "barbarian-brutal-critical-2": {
  "key": "barbarian-brutal-critical-2",
  "name": "凶蛮重击（2 骰）",
  "text": "凶蛮重击的额外武器伤害骰增加到两枚。"
 },
 "barbarian-brutal-critical-3": {
  "key": "barbarian-brutal-critical-3",
  "name": "凶蛮重击（3 骰）",
  "text": "凶蛮重击的额外武器伤害骰增加到三枚。"
 },
 "barbarian-relentless-rage": {
  "key": "barbarian-relentless-rage",
  "name": "坚韧狂暴",
  "text": "狂暴时，如果你的生命值降到 0 且没有立即死亡，你可以进行一次 DC 10 的体质豁免。成功则生命值变为 1。每次使用这项特性后，DC 增加 5；完成一次长休后，DC 重置为 10。"
 },
 "barbarian-persistent-rage": {
  "key": "barbarian-persistent-rage",
  "name": "持久狂暴",
  "text": "你狂暴时的情绪高涨得难以抑制，以至于只有当你昏迷或是主动终止狂暴时才能使之提前结束。"
 },
 "barbarian-indomitable-might": {
  "key": "barbarian-indomitable-might",
  "name": "不屈勇武",
  "text": "如果你的力量检定结果低于你的力量值，你可以直接用力量值代替检定结果。"
 },
 "barbarian-primal-champion": {
  "key": "barbarian-primal-champion",
  "name": "原初斗士",
  "text": "你的存在即是野性之力的具现。你的力量和体质各提升 4。并且你这两项属性的上限变为 24。"
 },
 "bard-bardic-inspiration": {
  "key": "bard-bardic-inspiration",
  "name": "诗人激励",
  "text": "你能通过言语、音乐或舞蹈以超自然的方式激励他人。这种激励用你的诗人激励骰来表示，它是一枚 d6。\n使用诗人激励。你可以以一个附赠动作，激励你周围 60 尺内一个能看见或听见你的其他生物。该生物获得一枚你的诗人激励骰。一个生物同一时间只能拥有一枚诗人激励骰。\n在接下来的 1 小时内，当该生物的某次 d20 检定失败时，它可以掷这枚诗人激励骰（仅限一次），并把掷出的数字加到 d20 上，这有可能让失败变成成功。诗人激励骰一经掷出即被消耗。\n使用次数。你能给出诗人激励骰的次数等于你的魅力调整值（最少一次），你完成一次长休时恢复所有已消耗的使用次数。\n"
 },
 "bard-spellcasting": {
  "key": "bard-spellcasting",
  "name": "施法",
  "text": "你学会了通过吟游诗人的技艺施展法术。施法规则见「法术」章节。下面说明你如何对吟游诗人法术运用这些规则；吟游诗人法术见本职业说明后面的吟游诗人法术列表。\n戏法。你知道两个你从吟游诗人法术列表中选择的戏法。推荐《舞光术》和《恶言相加》。\n每当你获得一个吟游诗人等级时，你可以把你的一个戏法替换为另一个你从吟游诗人法术列表中选择的戏法。\n当你达到吟游诗人 4 级和 10 级时，你从吟游诗人法术列表中再学会一个你选择的戏法，见吟游诗人特性表的「戏法」一栏。\n法术位。吟游诗人特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，从吟游诗人法术列表中选择四个 1 环法术。推荐《魅惑人类》《七彩喷射》《不谐低语》和《治疗真言》。\n你列表上的法术数量随吟游诗人等级提升而增加，见吟游诗人特性表的「准备法术」一栏。每当这个数字增加时，从吟游诗人法术列表中选择额外的法术，直到你列表上的法术数量与表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 3 级吟游诗人，你的准备法术列表可以包含六个 1 环和 2 环的法术，环阶任意组合。\n如果另一项吟游诗人特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作吟游诗人法术。\n更换准备法术。每当你获得一个吟游诗人等级时，你可以把列表上的一个法术替换为另一个你拥有对应法术位的吟游诗人法术。\n施法属性。魅力是你吟游诗人法术的施法属性。\n施法法器。你可以把乐器当作你吟游诗人法术的施法法器。"
 },
 "bard-expertise": {
  "key": "bard-expertise",
  "name": "专精",
  "text": "第 3 级起，你选择两个已有的技能熟练项。此后你进行所选技能的属性检定时，可以使用双倍的熟练加值。"
 },
 "bard-expertise-2": {
  "key": "bard-expertise-2",
  "name": "专精（额外两项）",
  "text": "你再选择两个已有的技能熟练项，从专精中获益。"
 },
 "bard-magical-secrets-1": {
  "key": "bard-magical-secrets-1",
  "name": "魔法奥秘",
  "text": "你从所有职业的法术列表里选择两个法术（包括诗人列表）加入已知法术中。所选法术必须是你当前等级可以施展的环阶法术或戏法；对你而言视为吟游诗人法术。"
 },
 "bard-magical-secrets-2": {
  "key": "bard-magical-secrets-2",
  "name": "魔法奥秘（再两项）",
  "text": "你再从所有职业的法术列表里选择两个法术加入已知法术中，要求同魔法奥秘。"
 },
 "bard-magical-secrets-3": {
  "key": "bard-magical-secrets-3",
  "name": "魔法奥秘（再两项）",
  "text": "你再从所有职业的法术列表里选择两个法术加入已知法术中，要求同魔法奥秘。"
 },
 "bard-superior-inspiration": {
  "key": "bard-superior-inspiration",
  "name": "先发激励",
  "text": "第 20 级起，你掷先攻时若没有可用的诗人激励次数，则获得一次使用次数。"
 },
 "bard-jack-of-all-trades": {
  "key": "bard-jack-of-all-trades",
  "name": "万事通",
  "text": "当你进行的属性检定使用了一项你不熟练的技能，并且该检定没有以其他方式用到你的熟练加值时，你可以在这次检定中加上你熟练加值的一半（向下取整）。\n例如，如果你进行一次力量（运动）检定而你不熟练运动，你可以在这次检定中加上你熟练加值的一半。"
 },
 "bard-song-of-rest-1": {
  "key": "bard-song-of-rest-1",
  "name": "休憩曲",
  "text": "第 2 级起，你可以在短休时用轻柔的音乐或话语帮助伙伴们恢复伤势。如果你或任何友方生物可以在其短休时听到你的演奏声，且决定在此时使用生命骰恢复生命值，则其恢复量可以额外增加 1d6。"
 },
 "bard-song-of-rest-2": {
  "key": "bard-song-of-rest-2",
  "name": "休憩曲（1d8）",
  "text": "短休时听到你演奏的伙伴使用生命骰恢复生命值，额外恢复量增加到 1d8。"
 },
 "bard-song-of-rest-3": {
  "key": "bard-song-of-rest-3",
  "name": "休憩曲（1d10）",
  "text": "短休时听到你演奏的伙伴使用生命骰恢复生命值，额外恢复量增加到 1d10。"
 },
 "bard-song-of-rest-4": {
  "key": "bard-song-of-rest-4",
  "name": "休憩曲（1d12）",
  "text": "短休时听到你演奏的伙伴使用生命骰恢复生命值，额外恢复量增加到 1d12。"
 },
 "bard-countercharm": {
  "key": "bard-countercharm",
  "name": "反迷惑",
  "text": "第 6 级起，你获得用音乐或话语来打断心控效应的能力。你可以使用一个动作开始一场持续至你的下一回合结束的演出。在这段时间内，你与你身边 30 尺内的友方生物进行对抗恐慌或魅惑效应的豁免检定具有优势。该生物必须能听到你的声音才能获得此增益。这场表演只有当你陷入失能、沉默状态，或主动终止（无需动作）时才会提前结束。"
 },
 "bard-subclass": {
  "key": "bard-subclass",
  "name": "吟游诗人子职业",
  "text": "你获得一个你选择的吟游诗人子职业。子职业是一种专精方向，会在特定的吟游诗人等级给予你特性。在此后的冒险生涯中，凡是等级不高于你吟游诗人等级的子职业特性，你都会获得。"
 },
 "bard-ability-score-improvement": {
  "key": "bard-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "bard-font-of-inspiration": {
  "key": "bard-font-of-inspiration",
  "name": "激励之源",
  "text": "现在，你完成一次短休或长休时，都会恢复所有已消耗的诗人激励使用次数。\n此外，你可以消耗一个法术位（不需要动作）来恢复一次已消耗的诗人激励使用次数。"
 },
 "cleric-divine-order": {
  "key": "cleric-divine-order",
  "name": "神圣职责",
  "text": "你献身于下列神圣角色之一，由你选择。\n护卫者。你受过战斗训练，获得军用武器的熟练和重甲受训。\n奇术师。你额外知道一个牧师法术列表中的戏法。此外，你与神圣之间的神秘联系让你的智力（奥秘或宗教）检定获得一个加值，加值等于你的感知调整值（最少 +1）。"
 },
 "cleric-spellcasting": {
  "key": "cleric-spellcasting",
  "name": "施法",
  "text": "你学会了通过祈祷和冥想施展法术。施法规则见「法术」章节。下面说明你如何对牧师法术运用这些规则；牧师法术见本职业说明后面的牧师法术列表。\n戏法。你知道三个你从牧师法术列表中选择的戏法。推荐《神导术》《圣火术》和《奇术》。\n每当你获得一个牧师等级时，你可以把你的一个戏法替换为另一个你从牧师法术列表中选择的戏法。\n当你达到牧师 4 级和 10 级时，你从牧师法术列表中再学会一个你选择的戏法，见牧师特性表的「戏法」一栏。\n法术位。牧师特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，从牧师法术列表中选择四个 1 环法术。推荐《祝福术》《疗伤术》《光导箭》和《虔诚护盾》。\n你列表上的法术数量随牧师等级提升而增加，见牧师特性表的「准备法术」一栏。每当这个数字增加时，从牧师法术列表中选择额外的法术，直到你列表上的法术数量与表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 3 级牧师，你的准备法术列表可以包含六个 1 环和 2 环的法术，环阶任意组合。\n如果另一项牧师特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作牧师法术。\n更换准备法术。每当你完成一次长休时，你可以更改你的准备法术列表，把列表上的任意法术替换为其他你拥有对应法术位的牧师法术。\n施法属性。感知是你牧师法术的施法属性。\n施法法器。你可以把圣徽当作你牧师法术的施法法器。"
 },
 "cleric-channel-divinity": {
  "key": "cleric-channel-divinity",
  "name": "引导神力",
  "text": "第 2 级起，你获得引导神祇所授予神圣能量的能力。你最初获得两种效应：驱散不死生物和另一个与你所选领域相关的效应。某些领域会在更高等级赋予更多效应。\n引导神力后，你必须完成一次短休或长休才能再次使用该特性；短休或长休会恢复所有已消耗的次数。第 6 级起可以在两次休息之间使用两次，第 18 级起可以使用三次。\n某些引导神力效应需要豁免，其豁免 DC 等于你的牧师法术豁免 DC。"
 },
 "cleric-subclass": {
  "key": "cleric-subclass",
  "name": "牧师子职业",
  "text": "你获得一个你选择的牧师子职业。子职业是一种专精方向，会在特定的牧师等级给予你特性。在此后的冒险生涯中，凡是等级不高于你牧师等级的子职业特性，你都会获得。"
 },
 "cleric-ability-score-improvement": {
  "key": "cleric-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "cleric-sear-undead": {
  "key": "cleric-sear-undead",
  "name": "灼烧不死",
  "text": "每当你使用驱散不死时，你可以掷数量等于你感知调整值的 d8（最少 1d8），并把结果相加。每个在这次驱散不死中豁免失败的不死生物，都受到等于掷骰总值的光耀伤害。这项伤害不会结束驱散效应。"
 },
 "cleric-turn-undead": {
  "key": "cleric-turn-undead",
  "name": "引导神力：驱散不死生物",
  "text": "你用一个动作展示圣徽并念出谴责不死生物的祷言。你身边 30 尺内能看见圣徽或听见祷言的不死生物必须进行一次感知豁免，失败则被驱散 1 分钟或直到受到任何伤害。\n被驱散生物必须用其回合内所有速度尽量远离你，且无法主动靠近你 30 尺内；它不能使用反应，只能使用疾走动作或从阻碍移动的效应中挣脱。无路可走时使用回避动作。"
 },
 "cleric-destroy-undead-0": {
  "key": "cleric-destroy-undead-0",
  "name": "摧毁不死生物（CR 1/2）",
  "text": "第 5 级起，当你使用驱散不死时，任何挑战等级不高于 1/2 的不死生物，若豁免失败，就会被即时摧毁。"
 },
 "cleric-domain-feature": {
  "key": "cleric-domain-feature",
  "name": "领域特性",
  "text": "你的神圣领域在 6、8、17 级各给予你一项领域特性。具体特性由你选择的领域决定。"
 },
 "cleric-destroy-undead-1": {
  "key": "cleric-destroy-undead-1",
  "name": "摧毁不死生物（CR 1）",
  "text": "当你使用驱散不死时，任何挑战等级不高于 1 的不死生物，若在这次驱散中豁免失败，就会被摧毁。"
 },
 "cleric-destroy-undead-2": {
  "key": "cleric-destroy-undead-2",
  "name": "摧毁不死生物（CR 2）",
  "text": "当你使用驱散不死时，任何挑战等级不高于 2 的不死生物，若在这次驱散中豁免失败，就会被摧毁。"
 },
 "cleric-destroy-undead-3": {
  "key": "cleric-destroy-undead-3",
  "name": "摧毁不死生物（CR 3）",
  "text": "当你使用驱散不死时，任何挑战等级不高于 3 的不死生物，若在这次驱散中豁免失败，就会被摧毁。"
 },
 "cleric-destroy-undead-4": {
  "key": "cleric-destroy-undead-4",
  "name": "摧毁不死生物（CR 4）",
  "text": "当你使用驱散不死时，任何挑战等级不高于 4 的不死生物，若在这次驱散中豁免失败，就会被摧毁。"
 },
 "cleric-divine-intervention": {
  "key": "cleric-divine-intervention",
  "name": "神圣干预",
  "text": "你用一个动作向所信仰的神祇请求帮助。描述你需要的帮助，然后掷 d100；若结果等于或小于你的牧师等级，神祇就会回应。回应由主持人选择，通常任何牧师法术或领域法术的效应都可以接受。\n若神祇回应，你在此后 7 日内无法再次使用该特性；若没有回应，你完成一次长休后可以再次使用。"
 },
 "cleric-divine-intervention-improved": {
  "key": "cleric-divine-intervention-improved",
  "name": "神圣干预增效",
  "text": "你的神圣干预现在自动成功，不需要掷百分骰。"
 },
 "druid-druidic": {
  "key": "druid-druidic",
  "name": "德鲁伊语",
  "text": "你懂得德鲁伊语，这是德鲁伊的秘密语言。在学习这门古老语言的过程中，你也解开了与动物沟通的魔法：你始终准备着《动物交谈》法术。\n你可以用德鲁伊语留下隐秘的讯息。你和其他懂德鲁伊语的人会自动发现这样的讯息。其他人需要在一次 DC 15 的智力（调查）检定中成功，才能发现讯息的存在，而且不借助魔法就无法解读它。"
 },
 "druid-primal-order": {
  "key": "druid-primal-order",
  "name": "原初职责",
  "text": "你献身于下列神圣角色之一，由你选择。\n秘术师。你额外知道一个德鲁伊法术列表中的戏法。此外，你与自然之间的神秘联系让你的智力（奥秘或自然）检定获得一个加值，加值等于你的感知调整值（加值最少 +1）。\n守护者。你受过战斗训练，获得军用武器的熟练和中甲受训。"
 },
 "druid-spellcasting": {
  "key": "druid-spellcasting",
  "name": "施法",
  "text": "你学会了通过研究自然的神秘力量施展法术。施法规则见「法术」章节。下面说明你如何对德鲁伊法术运用这些规则；德鲁伊法术见本职业说明后面的德鲁伊法术列表。\n戏法。你知道两个你从德鲁伊法术列表中选择的戏法。推荐《德鲁伊伎俩》和《燃火术》。\n每当你获得一个德鲁伊等级时，你可以把你的一个戏法替换为另一个你从德鲁伊法术列表中选择的戏法。\n当你达到德鲁伊 4 级和 10 级时，你从德鲁伊法术列表中再学会一个你选择的戏法，见德鲁伊特性表的「戏法」一栏。\n法术位。德鲁伊特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，从德鲁伊法术列表中选择四个 1 环法术。推荐《动物交友》《疗伤术》《妖火》和《雷鸣波》。\n你列表上的法术数量随德鲁伊等级提升而增加，见德鲁伊特性表的「准备法术」一栏。每当这个数字增加时，从德鲁伊法术列表中选择额外的法术，直到你列表上的法术数量与表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 3 级德鲁伊，你的准备法术列表可以包含六个 1 环和 2 环的法术，环阶任意组合。\n如果另一项德鲁伊特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作德鲁伊法术。\n更换准备法术。每当你完成一次长休时，你可以更改你的准备法术列表，把列表上的任意法术替换为其他你拥有对应法术位的德鲁伊法术。\n施法属性。感知是你德鲁伊法术的施法属性。\n施法法器。你可以把德鲁伊法器当作你德鲁伊法术的施法法器。"
 },
 "druid-wild-shape": {
  "key": "druid-wild-shape",
  "name": "荒野变形",
  "text": "自然之力让你能化身为动物的形态。你以一个附赠动作变形为一种你为这项特性学会的野兽形态（见下文「已知形态」）。你维持这个形态的小时数等于你德鲁伊等级的一半，或者直到你再次使用荒野变形、陷入失能状态或死亡为止。你也可以用一个附赠动作提前脱离这个形态。\n使用次数。你可以使用荒野变形两次。你完成一次短休时恢复一次已消耗的使用次数，完成一次长休时恢复所有已消耗的使用次数。\n你在达到特定的德鲁伊等级时获得更多使用次数，见德鲁伊特性表的「荒野变形」一栏。\n已知形态。你为这项特性知道四种野兽形态，从挑战等级不超过 1/4 且没有飞行速度的野兽数据卡中选择（可选的数据卡见「怪物」中的「动物」部分）。推荐鼠、乘用马、蜘蛛和狼。每当你完成一次长休时，你可以把一种已知形态替换为另一种符合条件的形态。\n当你达到特定的德鲁伊等级时，你已知形态的数量和这些形态的最高挑战等级都会提高，见「野兽形态」表。此外，从 8 级开始，你可以变成具有飞行速度的形态。\n选择已知形态时，如果游戏主持人允许，你可以从其他资料中寻找符合条件的野兽。\n野兽形态表：\n德鲁伊 2 级：已知形态 4 种，最高挑战等级 1/4，不能有飞行速度\n德鲁伊 4 级：已知形态 6 种，最高挑战等级 1/2，不能有飞行速度\n德鲁伊 8 级：已知形态 8 种，最高挑战等级 1，可以有飞行速度\n变形期间的规则。处于某个形态时，你保留自己的性格、记忆和说话能力，并适用下列规则：\n临时生命值。当你变成荒野变形的形态时，你获得等于你德鲁伊等级的临时生命值。\n游戏数据。你的游戏数据被该野兽的数据卡取代，但你保留自己的生物类型、生命值、生命骰、智力值、感知值和魅力值、职业特性、语言和专长。你也保留自己的技能熟练和豁免熟练，并对它们使用你的熟练加值，同时还获得该生物的熟练。如果野兽数据卡中某项技能或豁免的调整值比你的高，就使用数据卡中的数值。\n不能施法。你无法施展法术，但变形不会打断你的专注，也不会以其他方式干扰你已经施展的法术。\n物品。你操作物品的能力由该形态的肢体决定，而不是你原本的肢体。此外，你可以选择让你的装备掉落在你所在的空间、融入你的新形态，或由新形态穿戴。穿戴着的装备照常起作用，但由游戏主持人根据该生物的体型和形状，决定新形态穿戴某件装备是否可行。你的装备不会改变大小或形状来配合新形态，新形态无法穿戴的装备必须掉落到地上或融入该形态。融入形态的装备在你处于该形态期间不起任何作用。"
 },
 "druid-wild-companion": {
  "key": "druid-wild-companion",
  "name": "荒野伙伴",
  "text": "你能召唤一个化为动物形态的自然精魂来协助你。你可以以一个魔法动作，消耗一个法术位或一次荒野变形的使用次数，在不需要材料成分的情况下施展《寻获魔宠》法术。\n以这种方式施展这个法术时，魔宠是精类，并会在你完成一次长休时消失。"
 },
 "druid-subclass": {
  "key": "druid-subclass",
  "name": "德鲁伊子职业",
  "text": "你获得一个你选择的德鲁伊子职业。子职业是一种专精方向，会在特定的德鲁伊等级给予你特性。在此后的冒险生涯中，凡是等级不高于你德鲁伊等级的子职业特性，你都会获得。"
 },
 "druid-ability-score-improvement": {
  "key": "druid-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "druid-wild-resurgence": {
  "key": "druid-wild-resurgence",
  "name": "荒野复苏",
  "text": "在你的每个回合中限一次，如果你已经没有剩余的荒野变形使用次数，你可以消耗一个法术位（不需要动作）来给自己一次使用次数。\n此外，你可以消耗一次荒野变形的使用次数（不需要动作）来给自己一个 1 环法术位，但在你完成一次长休之前不能再这样做。"
 },
 "fighter-fighting-style": {
  "key": "fighter-fighting-style",
  "name": "战斗风格",
  "text": "你磨练了自己的武艺，获得一个你选择的战斗风格专长（见「专长」章节）。推荐防御。\n每当你获得一个战士等级时，你可以把所选的专长替换为另一个战斗风格专长。"
 },
 "fighter-second-wind": {
  "key": "fighter-second-wind",
  "name": "回气",
  "text": "你拥有一股有限的体力和精力储备，可以随时动用。你可以以一个附赠动作动用它，恢复等于 1d10 + 你战士等级的生命值。\n你可以使用这项特性两次。你完成一次短休时恢复一次已消耗的使用次数，完成一次长休时恢复所有已消耗的使用次数。\n当你达到特定的战士等级时，你获得这项特性更多的使用次数，见战士特性表的「回气」一栏。"
 },
 "fighter-weapon-mastery": {
  "key": "fighter-weapon-mastery",
  "name": "武器精通",
  "text": "你的武器训练让你能使用三种你选择的简易或军用武器的精通属性。每当你完成一次长休时，你可以进行武器操练，并更换其中一种武器选择。\n当你达到特定的战士等级时，你能使用更多种武器的精通属性，见战士特性表的「武器精通」一栏。"
 },
 "fighter-action-surge": {
  "key": "fighter-action-surge",
  "name": "动作如潮",
  "text": "你能在一瞬间突破自己平时的极限。在你的回合中，你可以执行一个额外的动作，但不能是魔法动作。\n使用这项特性后，你必须完成一次短休或长休才能再次使用。"
 },
 "fighter-tactical-mind": {
  "key": "fighter-tactical-mind",
  "name": "战术头脑",
  "text": "无论在战场内外，你都有战术头脑。当你的一次属性检定失败时，你可以消耗一次回气的使用次数，逼自己迈向成功：你不恢复生命值，而是掷 1d10 并把掷出的数字加到这次属性检定上，这有可能让检定变为成功。如果检定仍然失败，这次回气的使用次数不会被消耗。"
 },
 "fighter-subclass": {
  "key": "fighter-subclass",
  "name": "战士子职业",
  "text": "你获得一个你选择的战士子职业。子职业是一种专精方向，会在特定的战士等级给予你特性。在此后的冒险生涯中，凡是等级不高于你战士等级的子职业特性，你都会获得。"
 },
 "fighter-ability-score-improvement": {
  "key": "fighter-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "fighter-extra-attack": {
  "key": "fighter-extra-attack",
  "name": "额外攻击",
  "text": "每当你在自己的回合执行攻击动作时，你可以攻击两次，而不是一次。"
 },
 "fighter-tactical-shift": {
  "key": "fighter-tactical-shift",
  "name": "战术转移",
  "text": "每当你以附赠动作发动回气时，你可以移动最多等于你速度一半的距离，且这次移动不会引发借机攻击。"
 },
 "monk-martial-arts": {
  "key": "monk-martial-arts",
  "name": "武艺",
  "text": "你对武艺的修习让你精通使用徒手打击和武僧武器的战斗方式。武僧武器包括：\n- 简易近战武器\n- 具有轻型属性的军用近战武器\n当你徒手或只持用武僧武器，并且没有穿着护甲、也没有持用盾牌时，你获得下列好处。\n附赠徒手打击。你可以以一个附赠动作进行一次徒手打击。\n武艺骰。你可以掷 1d6 来代替你的徒手打击或武僧武器的正常伤害。这枚骰子随你的武僧等级提升而改变，见武僧特性表的「武艺」一栏。\n灵巧攻击。你的徒手打击和武僧武器的攻击检定和伤害掷骰，可以用你的敏捷调整值代替力量调整值。此外，当你使用徒手打击的擒抱或推撞选项时，你可以用敏捷调整值代替力量调整值来决定豁免 DC。"
 },
 "monk-unarmored-defense": {
  "key": "monk-unarmored-defense",
  "name": "无甲防御",
  "text": "当你没有穿着护甲、也没有持用盾牌时，你的基础护甲等级等于 10 + 你的敏捷调整值 + 你的感知调整值。"
 },
 "monk-monks-focus": {
  "key": "monk-monks-focus",
  "name": "武僧功力",
  "text": "你的专注和武术训练让你能驾驭体内一股非凡能量的源泉。这股能量用功力点表示。你拥有的功力点数量由你的武僧等级决定，见武僧特性表的「功力点」一栏。\n你可以消耗功力点来强化或驱动某些武僧特性。你一开始知道三项这样的特性：疾风连击、坚强防御和疾步如风，详见下文。\n你消耗的功力点在你完成一次短休或长休之前都无法再用；休息结束时，你恢复所有已消耗的功力点。\n某些使用功力点的特性要求目标进行豁免检定。豁免 DC 等于 8 + 你的感知调整值 + 你的熟练加值。\n疾风连击。你可以消耗 1 功力点，以一个附赠动作进行两次徒手打击。\n坚强防御。你可以以一个附赠动作执行撤离动作。或者，你可以消耗 1 功力点，以一个附赠动作同时执行撤离和闪避动作。\n疾步如风。你可以以一个附赠动作执行疾走动作。或者，你可以消耗 1 功力点，以一个附赠动作同时执行撤离和疾走动作，并且你的跳跃距离在本回合内翻倍。"
 },
 "monk-unarmored-movement": {
  "key": "monk-unarmored-movement",
  "name": "无甲移动",
  "text": "当你没有穿着护甲、也没有持用盾牌时，你的速度增加 10 尺。这项加值在你达到特定的武僧等级时会提高，见武僧特性表。"
 },
 "monk-uncanny-metabolism": {
  "key": "monk-uncanny-metabolism",
  "name": "超凡代谢",
  "text": "当你掷先攻时，你可以恢复所有已消耗的功力点。这样做时，掷你的武艺骰，并恢复等于你武僧等级加上掷出数字的生命值。\n使用这项特性后，你必须完成一次长休才能再次使用。"
 },
 "monk-subclass": {
  "key": "monk-subclass",
  "name": "武僧子职业",
  "text": "你获得一个你选择的武僧子职业。子职业是一种专精方向，会在特定的武僧等级给予你特性。在此后的冒险生涯中，凡是等级不高于你武僧等级的子职业特性，你都会获得。"
 },
 "monk-deflect-attacks": {
  "key": "monk-deflect-attacks",
  "name": "拨挡攻击",
  "text": "当一次攻击检定命中你、且其伤害包含钝击、穿刺或挥砍伤害时，你可以用一个反应来减少这次攻击对你造成的总伤害。减少的数值等于 1d10 + 你的敏捷调整值 + 你的武僧等级。\n如果你把这次伤害减到 0，你可以消耗 1 功力点，把这次攻击的部分力道转向别处。这样做时，如果那次攻击是近战攻击，你选择你周围 5 尺内一个你能看见的生物；如果那次攻击是远程攻击，你选择你周围 60 尺内一个你能看见、且不在全身掩护后面的生物。该生物必须在一次敏捷豁免中成功，否则受到的伤害等于你掷两次武艺骰的结果 + 你的敏捷调整值。这项伤害的类型与那次攻击造成的伤害类型相同。"
 },
 "monk-ability-score-improvement": {
  "key": "monk-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "monk-slow-fall": {
  "key": "monk-slow-fall",
  "name": "缓坠",
  "text": "当你坠落时，你可以用一个反应，把你因这次坠落受到的伤害减少，减少量等于你武僧等级的五倍。"
 },
 "monk-extra-attack": {
  "key": "monk-extra-attack",
  "name": "额外攻击",
  "text": "每当你在自己的回合执行攻击动作时，你可以攻击两次，而不是一次。"
 },
 "monk-stunning-strike": {
  "key": "monk-stunning-strike",
  "name": "震慑拳",
  "text": "每回合限一次，当你用武僧武器或徒手打击命中一个生物时，你可以消耗 1 功力点尝试一次震慑拳。目标必须进行一次体质豁免。豁免失败时，目标陷入震慑状态，直到你的下个回合开始。豁免成功时，目标的速度减半，直到你的下个回合开始，并且在此之前针对该目标的下一次攻击检定具有优势。"
 },
 "paladin-lay-on-hands": {
  "key": "paladin-lay-on-hands",
  "name": "圣疗",
  "text": "你受祝福的触碰能治愈伤口。你拥有一个治疗能量池，它在你完成一次长休时补满。用这个能量池，你总共能恢复等于你圣武士等级五倍的生命值。\n你可以以一个附赠动作触碰一个生物（可以是你自己），从治疗池中汲取能量，为该生物恢复一定数量的生命值，最多为池中剩余的全部数值。\n你也可以从治疗池中消耗 5 点生命值来移除该生物的中毒状态；这些点数不会同时为该生物恢复生命值。"
 },
 "paladin-spellcasting": {
  "key": "paladin-spellcasting",
  "name": "施法",
  "text": "你学会了通过祈祷和冥想施展法术。施法规则见「法术」章节。下面说明你如何对圣武士法术运用这些规则；圣武士法术见本职业说明后面的圣武士法术列表。\n法术位。圣武士特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，选择两个 1 环圣武士法术。推荐《英雄气概》和《灼热斩》。\n你列表上的法术数量随圣武士等级提升而增加，见圣武士特性表的「准备法术」一栏。每当这个数字增加时，选择额外的圣武士法术，直到你列表上的法术数量与圣武士特性表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 5 级圣武士，你的准备法术列表可以包含六个 1 环或 2 环的圣武士法术，环阶任意组合。\n如果另一项圣武士特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作圣武士法术。\n更换准备法术。每当你完成一次长休时，你可以把列表上的一个法术替换为另一个你拥有对应法术位的圣武士法术。\n施法属性。魅力是你圣武士法术的施法属性。\n施法法器。你可以把圣徽当作你圣武士法术的施法法器。"
 },
 "paladin-weapon-mastery": {
  "key": "paladin-weapon-mastery",
  "name": "武器精通",
  "text": "你的武器训练让你能使用两种你选择且你熟练的武器的精通属性，比如长剑和标枪。\n每当你完成一次长休时，你可以更换所选的武器种类。例如，你可以改为使用长戟和链枷的精通属性。"
 },
 "paladin-fighting-style": {
  "key": "paladin-fighting-style",
  "name": "战斗风格",
  "text": "你获得一个你选择的战斗风格专长（专长见「专长」章节）。你也可以不选这些专长，改为选择下面的选项。\n受祝福的战士。你学会两个你选择的牧师戏法（牧师法术列表见牧师职业部分）。推荐《神导术》和《圣火术》。所选的戏法对你来说算作圣武士法术，魅力是你施展它们的施法属性。每当你获得一个圣武士等级时，你可以把其中一个戏法替换为另一个牧师戏法。"
 },
 "paladin-paladins-smite": {
  "key": "paladin-paladins-smite",
  "name": "圣武士斩击",
  "text": "你始终准备着《至圣斩》法术。此外，你可以不消耗法术位施展它，但必须完成一次长休才能再次以这种方式施展它。"
 },
 "paladin-channel-divinity": {
  "key": "paladin-channel-divinity",
  "name": "引导神力",
  "text": "你能直接从外层位面引导神圣能量，用它驱动魔法效应。你一开始掌握一种这样的效应：神圣感知，详见下文。其他圣武士特性会提供更多引导神力效应选项。每次使用本职业的引导神力时，你从本职业的效应中选择一种来产生。\n你可以使用本职业的引导神力两次。你完成一次短休时恢复一次已消耗的使用次数，完成一次长休时恢复所有已消耗的使用次数。\n如果某个引导神力效应需要进行豁免检定，其 DC 等于本职业施法特性的法术豁免 DC。\n神圣感知。你可以以一个附赠动作敞开感知，侦测天界生物、邪魔和不死生物。在接下来的 10 分钟内，或直到你陷入失能状态为止，你知道你周围 60 尺内任何此类生物的位置，也知道它的生物类型。在同样的半径内，你还能察觉任何被祝圣或被亵渎的地点或物体的存在，就像《圣居》法术那样。"
 },
 "paladin-subclass": {
  "key": "paladin-subclass",
  "name": "圣武士子职业",
  "text": "你获得一个你选择的圣武士子职业。子职业是一种专精方向，会在特定的圣武士等级给予你特性。在此后的冒险生涯中，凡是等级不高于你圣武士等级的子职业特性，你都会获得。"
 },
 "paladin-ability-score-improvement": {
  "key": "paladin-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "paladin-extra-attack": {
  "key": "paladin-extra-attack",
  "name": "额外攻击",
  "text": "每当你在自己的回合执行攻击动作时，你可以攻击两次，而不是一次。"
 },
 "paladin-faithful-steed": {
  "key": "paladin-faithful-steed",
  "name": "忠诚坐骑",
  "text": "你能召来一匹异界坐骑相助。你始终准备着《寻获坐骑》法术。\n你还可以不消耗法术位施展这个法术一次，并在完成一次长休时恢复这样做的能力。"
 },
 "ranger-favored-enemy": {
  "key": "ranger-favored-enemy",
  "name": "宿敌",
  "text": "你始终准备着《猎人印记》法术。你可以不消耗法术位施展它两次，并在完成一次长休时恢复这项能力所有已消耗的使用次数。\n你不用法术位施展这个法术的次数，在你达到特定的游侠等级时会增加，见游侠特性表的「宿敌」一栏。"
 },
 "ranger-spellcasting": {
  "key": "ranger-spellcasting",
  "name": "施法",
  "text": "你学会了引导自然的魔法精华来施展法术。施法规则见「法术」章节。下面说明你如何对游侠法术运用这些规则；游侠法术见本职业说明后面的游侠法术列表。\n法术位。游侠特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，选择两个 1 环游侠法术。推荐《疗伤术》和《诱捕打击》。\n你列表上的法术数量随游侠等级提升而增加，见游侠特性表的「准备法术」一栏。每当这个数字增加时，选择额外的游侠法术，直到你列表上的法术数量与游侠特性表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 5 级游侠，你的准备法术列表可以包含六个 1 环或 2 环的游侠法术，环阶任意组合。\n如果另一项游侠特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作游侠法术。\n更换准备法术。每当你完成一次长休时，你可以把列表上的一个法术替换为另一个你拥有对应法术位的游侠法术。\n施法属性。感知是你游侠法术的施法属性。\n施法法器。你可以把德鲁伊法器当作你游侠法术的施法法器。"
 },
 "ranger-weapon-mastery": {
  "key": "ranger-weapon-mastery",
  "name": "武器精通",
  "text": "你的武器训练让你能使用两种你选择且你熟练的武器的精通属性，比如长弓和短剑。\n每当你完成一次长休时，你可以更换所选的武器种类。例如，你可以改为使用弯刀和长剑的精通属性。"
 },
 "ranger-deft-explorer": {
  "key": "ranger-deft-explorer",
  "name": "老练探险家",
  "text": "得益于你的游历，你获得下列好处。\n专精。选择一项你已熟练但尚未专精的技能，你获得该技能的专精。\n语言。你从「角色创建」的语言表中选择两种语言，你懂得这两种语言。"
 },
 "ranger-fighting-style": {
  "key": "ranger-fighting-style",
  "name": "战斗风格",
  "text": "你获得一个你选择的战斗风格专长（见「专长」章节）。你也可以不选这些专长，改为选择下面的选项。\n德鲁伊战士。你学会两个你选择的德鲁伊戏法（德鲁伊法术列表见德鲁伊职业部分）。推荐《神导术》和《星光微芒》。所选的戏法对你来说算作游侠法术，感知是你施展它们的施法属性。每当你获得一个游侠等级时，你可以把其中一个戏法替换为另一个德鲁伊戏法。"
 },
 "ranger-subclass": {
  "key": "ranger-subclass",
  "name": "游侠子职业",
  "text": "你获得一个你选择的游侠子职业。子职业是一种专精方向，会在特定的游侠等级给予你特性。在此后的冒险生涯中，凡是等级不高于你游侠等级的子职业特性，你都会获得。"
 },
 "ranger-ability-score-improvement": {
  "key": "ranger-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "ranger-extra-attack": {
  "key": "ranger-extra-attack",
  "name": "额外攻击",
  "text": "每当你在自己的回合执行攻击动作时，你可以攻击两次，而不是一次。"
 },
 "rogue-expertise": {
  "key": "rogue-expertise",
  "name": "专精",
  "text": "你在两项你选择的、你已熟练的技能上获得专精。如果你熟练巧手和隐匿，推荐选择这两项。\n"
 },
 "rogue-sneak-attack": {
  "key": "rogue-sneak-attack",
  "name": "偷袭",
  "text": "你懂得如何出其不意地出手，利用敌人的分心。每回合限一次，如果你的攻击检定具有优势，并且这次攻击使用的是灵巧武器或远程武器，你可以对一个被你这次攻击检定命中的生物额外造成 1d6 伤害。额外伤害的类型与该武器的伤害类型相同。\n如果你至少有一名盟友位于目标 5 尺内、该盟友没有陷入失能状态，并且你的攻击检定没有劣势，那么你的攻击检定不需要具有优势。\n额外伤害随你的游荡者等级提升而增加，见游荡者特性表的「偷袭」一栏。"
 },
 "rogue-thieves-cant": {
  "key": "rogue-thieves-cant",
  "name": "盗贼黑话",
  "text": "你在施展游荡者本事的各个圈子里学会了多种语言。你懂得盗贼黑话，以及另一种你从「角色创建」的语言表中选择的语言。"
 },
 "rogue-weapon-mastery": {
  "key": "rogue-weapon-mastery",
  "name": "武器精通",
  "text": "你的武器训练让你能使用两种你选择且你熟练的武器的精通属性，比如匕首和短弓。\n每当你完成一次长休时，你可以更换所选的武器种类。例如，你可以改为使用弯刀和短剑的精通属性。"
 },
 "rogue-cunning-action": {
  "key": "rogue-cunning-action",
  "name": "灵巧动作",
  "text": "你思维敏捷、身手灵活，能迅速移动和行动。在你的回合中，你可以以一个附赠动作执行下列动作之一：疾走、撤离或躲藏。"
 },
 "rogue-subclass": {
  "key": "rogue-subclass",
  "name": "游荡者子职业",
  "text": "你获得一个你选择的游荡者子职业。子职业是一种专精方向，会在特定的游荡者等级给予你特性。在此后的冒险生涯中，凡是等级不高于你游荡者等级的子职业特性，你都会获得。"
 },
 "rogue-steady-aim": {
  "key": "rogue-steady-aim",
  "name": "稳定瞄准",
  "text": "你以一个附赠动作，让你在本回合的下一次攻击检定具有优势。只有在你本回合还没有移动过时，你才能使用这项特性；使用之后，你的速度变为 0，直到本回合结束。"
 },
 "rogue-ability-score-improvement": {
  "key": "rogue-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "rogue-cunning-strike": {
  "key": "rogue-cunning-strike",
  "name": "灵巧打击",
  "text": "你想出了运用偷袭的巧妙手段。当你造成偷袭伤害时，你可以附加下列灵巧打击效果之一。\n每种效果都有一个骰子消耗，也就是为了附加该效果你必须放弃的偷袭伤害骰数量。你在掷骰前移除这些骰子，效果在这次攻击的伤害造成后立即发生。例如，如果你附加下毒效果，就在掷骰前从偷袭伤害中去掉 1d6。\n如果某个灵巧打击效果需要进行豁免检定，其 DC 等于 8 + 你的敏捷调整值 + 你的熟练加值。\n下毒（消耗：1d6）。你在这次攻击中加入毒素，迫使目标进行一次体质豁免。豁免失败时，目标陷入中毒状态，持续 1 分钟。中毒的目标在它的每个回合结束时重复这次豁免，成功则结束自身的这个效果。\n要使用这个效果，你必须随身带着制毒工具。\n绊倒（消耗：1d6）。如果目标的体型为大型或更小，它必须在一次敏捷豁免中成功，否则陷入倒地状态。\n撤身（消耗：1d6）。在这次攻击之后，你立即移动最多等于你速度一半的距离，且不会引发借机攻击。"
 },
 "rogue-uncanny-dodge": {
  "key": "rogue-uncanny-dodge",
  "name": "直觉闪避",
  "text": "当一个你能看见的攻击者用攻击检定命中你时，你可以用一个反应，把这次攻击对你造成的伤害减半（向下取整）。"
 },
 "sorcerer-innate-sorcery": {
  "key": "sorcerer-innate-sorcery",
  "name": "天生术法",
  "text": "你过去的某件事在你身上留下了无法磨灭的印记，让你体内充满了躁动的魔法。你可以以一个附赠动作释放这股魔法，持续 1 分钟，在此期间你获得下列好处：\n- 你的术士法术的法术豁免 DC 增加 1。\n- 你施展的术士法术的攻击检定具有优势。\n你可以使用这项特性两次，并在完成一次长休时恢复所有已消耗的使用次数。"
 },
 "sorcerer-spellcasting": {
  "key": "sorcerer-spellcasting",
  "name": "施法",
  "text": "你能汲取自己天生的魔法来施展法术。施法规则见「法术」章节。下面说明你如何对术士法术运用这些规则；术士法术见本职业说明后面的术士法术列表。\n戏法。你知道四个你选择的术士戏法。推荐《光亮术》《魔法伎俩》《电爪》和《术法爆发》。每当你获得一个术士等级时，你可以把一个通过这项特性获得的戏法替换为另一个你选择的术士戏法。\n当你达到术士 4 级和 10 级时，你再学会一个你选择的术士戏法，见术士特性表的「戏法」一栏。\n法术位。术士特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，选择两个 1 环术士法术。推荐《燃烧之手》和《侦测魔法》。\n你列表上的法术数量随术士等级提升而增加，见术士特性表的「准备法术」一栏。每当这个数字增加时，选择额外的术士法术，直到你列表上的法术数量与术士特性表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 3 级术士，你的准备法术列表可以包含六个 1 环或 2 环的术士法术，环阶任意组合。\n如果另一项术士特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作术士法术。\n更换准备法术。每当你获得一个术士等级时，你可以把列表上的一个法术替换为另一个你拥有对应法术位的术士法术。\n施法属性。魅力是你术士法术的施法属性。\n施法法器。你可以把奥术法器当作你术士法术的施法法器。"
 },
 "sorcerer-font-of-magic": {
  "key": "sorcerer-font-of-magic",
  "name": "魔力泉源",
  "text": "你能汲取自己体内的魔法泉源。这股泉源用术法点表示，你可以用术法点创造各种魔法效果。\n你有 2 术法点，并在达到更高等级时获得更多，见术士特性表的「术法点」一栏。你的术法点不能超过表中你的等级所对应的数字。你完成一次长休时恢复所有已消耗的术法点。\n你可以用术法点来驱动下列选项，以及超魔等其他使用术法点的特性。\n把法术位转化为术法点。你可以消耗一个法术位，获得等于该法术位环阶的术法点（不需要动作）。\n创造法术位。你可以以一个附赠动作，把尚未消耗的术法点转化为一个法术位。「创造法术位」表列出了创造各环法术位的消耗，以及创造该法术位所需的最低术士等级。你创造的法术位最高为 5 环。\n你用这项特性创造的法术位会在你完成一次长休时消失。\n创造法术位表：\n1 环法术位：消耗 2 术法点，术士等级至少 2 级\n2 环法术位：消耗 3 术法点，术士等级至少 3 级\n3 环法术位：消耗 5 术法点，术士等级至少 5 级\n4 环法术位：消耗 6 术法点，术士等级至少 7 级\n5 环法术位：消耗 7 术法点，术士等级至少 9 级"
 },
 "sorcerer-metamagic": {
  "key": "sorcerer-metamagic",
  "name": "超魔",
  "text": "因为你的魔法源自内在，你能改变法术以满足自己的需要：你从本职业说明后面的「超魔选项」中选择两个超魔选项获得。你用所选的选项临时调整你施展的法术。要使用一个选项，你必须花费它所需数量的术法点。\n施展一个法术时，你只能对它使用一个超魔选项，除非某个选项另有说明。\n每当你获得一个术士等级时，你可以把一个超魔选项替换为一个你还不知道的选项。"
 },
 "sorcerer-subclass": {
  "key": "sorcerer-subclass",
  "name": "术士子职业",
  "text": "你获得一个你选择的术士子职业。龙族术法子职业的详细内容见本职业说明之后。子职业是一种专精方向，会在特定的术士等级给予你特性。\n在此后的冒险生涯中，凡是等级不高于你术士等级的子职业特性，你都会获得。"
 },
 "sorcerer-ability-score-improvement": {
  "key": "sorcerer-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "sorcerer-sorcerous-restoration": {
  "key": "sorcerer-sorcerous-restoration",
  "name": "术法恢复",
  "text": "当你完成一次短休时，你可以恢复已消耗的术法点，但恢复的数量不超过你术士等级的一半（向下取整）。使用这项特性后，你必须完成一次长休才能再次使用。"
 },
 "warlock-eldritch-invocations": {
  "key": "warlock-eldritch-invocations",
  "name": "魔能祈唤",
  "text": "你发掘出了魔能祈唤：这些禁忌知识的碎片能赋予你持久的魔法能力或其他学识。你获得一个你选择的祈唤，比如魔典契约。祈唤详见本职业说明后面的「魔能祈唤选项」部分。\n前提。如果一个祈唤有前提，你必须满足前提才能学会它。例如，如果一个祈唤要求你是 5 级及以上的邪术师，你在达到邪术师 5 级时就可以选择它。\n替换和获得祈唤。每当你获得一个邪术师等级时，你可以把你的一个祈唤替换为另一个你符合条件的祈唤。如果某个祈唤是你拥有的另一个祈唤的前提，你就不能替换它。\n当你达到特定的邪术师等级时，你获得更多由你选择的祈唤，见邪术师特性表的「祈唤」一栏。\n除非祈唤的描述另有说明，否则同一个祈唤你不能选择多次。"
 },
 "warlock-pact-magic": {
  "key": "warlock-pact-magic",
  "name": "契约魔法",
  "text": "通过神秘的仪式，你与一个神秘的存在缔结了契约，从而获得魔法力量。\n那个存在是阴影中的一个声音，身份不明，但它给你的恩赐实实在在：施展法术的能力。施法规则见「法术」章节。\n下面说明你如何对邪术师法术运用这些规则；邪术师法术见本职业说明后面的邪术师法术列表。\n戏法。你知道两个你选择的邪术师戏法。推荐《魔能爆》和《魔法伎俩》。\n每当你获得一个邪术师等级时，你可以把一个通过这项特性获得的戏法替换为另一个你选择的邪术师戏法。\n当你达到邪术师 4 级和 10 级时，你再学会一个你选择的邪术师戏法，见邪术师特性表的「戏法」一栏。\n法术位。邪术师特性表列出了你可用来施展 1～5 环邪术师法术的法术位数量。表中也列出了这些法术位的环阶，它们全都是同一环阶。你完成一次短休或长休时，恢复所有已消耗的契约魔法法术位。\n例如，当你是 5 级邪术师时，你有两个 3 环法术位。要施展 1 环法术《魅惑人类》，你必须花费其中一个法术位，并以 3 环法术的形式施展它。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。一开始，选择两个 1 环邪术师法术。推荐《魅惑人类》和《脆弱诅咒》。\n你列表上的法术数量随邪术师等级提升而增加，见邪术师特性表的「准备法术」一栏。每当这个数字增加时，选择额外的邪术师法术，直到你列表上的法术数量与表中的数字相同。所选法术的环阶不能高于表中你的等级在「法术位环阶」一栏对应的环阶。例如，当你达到 6 级时，你学会一个新的邪术师法术，它可以是 1～3 环的法术。\n如果另一项邪术师特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作邪术师法术。\n更换准备法术。每当你获得一个邪术师等级时，你可以把列表上的一个法术替换为另一个环阶符合条件的邪术师法术。\n施法属性。魅力是你邪术师法术的施法属性。\n施法法器。你可以把奥术法器当作你邪术师法术的施法法器。"
 },
 "warlock-magical-cunning": {
  "key": "warlock-magical-cunning",
  "name": "魔法机巧",
  "text": "你可以进行一场持续 1 分钟的秘传仪式。仪式结束时，你恢复已消耗的契约魔法法术位，但恢复的数量不超过你契约魔法法术位上限的一半（向上取整）。使用这项特性后，你必须完成一次长休才能再次使用。"
 },
 "warlock-subclass": {
  "key": "warlock-subclass",
  "name": "邪术师子职业",
  "text": "你获得一个你选择的邪术师子职业。邪魔宗主子职业的详细内容见本职业说明之后。子职业是一种专精方向，会在特定的邪术师等级给予你特性。在此后的冒险生涯中，凡是等级不高于你邪术师等级的子职业特性，你都会获得。"
 },
 "warlock-ability-score-improvement": {
  "key": "warlock-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "wizard-arcane-recovery": {
  "key": "wizard-arcane-recovery",
  "name": "奥术回复",
  "text": "你可以通过研读法术书恢复部分魔法能量。当你完成一次短休时，你可以选择一些已消耗的法术位来恢复。\n这些法术位的环阶总和不能超过你法师等级的一半（向上取整），而且其中任何一个都不能是 6 环或更高。\n例如，如果你是 4 级法师，你最多可以恢复总共两环的法术位：恢复一个 2 环法术位，或者两个 1 环法术位。\n使用这项特性后，你必须完成一次长休才能再次使用。"
 },
 "wizard-ritual-adept": {
  "key": "wizard-ritual-adept",
  "name": "仪式专家",
  "text": "只要一个法术具有仪式标签并且记在你的法术书中，你就可以把它作为仪式施展。你不需要准备该法术，但以这种方式施法时，你必须照着法术书念诵。"
 },
 "wizard-spellcasting": {
  "key": "wizard-spellcasting",
  "name": "施法",
  "text": "作为奥术魔法的学徒，你学会了施展法术。施法规则见「法术」章节。\n下面说明你如何对法师法术运用这些规则；法师法术见本职业说明后面的法师法术列表。\n戏法。你知道三个你选择的法师戏法。推荐《光亮术》《法师之手》和《冷冻射线》。\n每当你完成一次长休时，你可以把一个通过这项特性获得的戏法替换为另一个你选择的法师戏法。\n当你达到法师 4 级和 10 级时，你再学会一个你选择的法师戏法，见法师特性表的「戏法」一栏。\n法术书。你的法师学徒生涯以创造一本独一无二的书告终：你的法术书。它是一个微型物体，重 3 磅，共 100 页，只有你或者正在施展《鉴定术》的人才能阅读。书的外观和材质由你决定，比如一本镶金边的大部头，或者一沓用细绳装订的犊皮纸。\n这本书记载着你知道的 1 环及以上的法术。一开始，书中有六个你选择的 1 环法师法术。\n推荐《侦测魔法》《羽落术》《法师护甲》《魔法飞弹》《睡眠术》和《雷鸣波》。\n在 1 级之后，你每获得一个法师等级，就把两个你选择的法师法术加入你的法术书。这些法术都必须是你拥有法术位的环阶，见法师特性表。\n这些法术是你定期进行奥术研究的成果。\n法术位。法师特性表列出了你可用来施展 1 环及以上法术的法术位数量。你完成一次长休时恢复所有已消耗的法术位。\n1 环及以上的准备法术。你要准备一份 1 环及以上的法术列表，列表上的就是你能用这项特性施展的法术。为此，从你的法术书中选择四个法术。所选法术必须是你拥有法术位的环阶。\n你列表上的法术数量随法师等级提升而增加，见法师特性表的「准备法术」一栏。每当这个数字增加时，选择额外的法师法术，直到你列表上的法术数量与表中的数字相同。所选法术必须是你拥有法术位的环阶。例如，如果你是 3 级法师，你的准备法术列表可以包含六个 1 环和 2 环的法术，环阶任意组合，都从你的法术书中选择。\n如果另一项法师特性给予你始终准备的法术，这些法术不计入你能用这项特性准备的法术数量，但在其他方面，这些法术对你来说都算作法师法术。\n更换准备法术。每当你完成一次长休时，你可以更改你的准备法术列表，把列表上的任意法术替换为你法术书中的法术。\n施法属性。智力是你法师法术的施法属性。\n施法法器。你可以把奥术法器或你的法术书当作你法师法术的施法法器。"
 },
 "wizard-scholar": {
  "key": "wizard-scholar",
  "name": "学者",
  "text": "在钻研魔法的同时，你还专攻了另一个学术领域。从下列技能中选择一项你已熟练的技能：奥秘、历史、调查、医药、自然或宗教。\n你在所选技能上具有专精。"
 },
 "wizard-subclass": {
  "key": "wizard-subclass",
  "name": "法师子职业",
  "text": "你获得一个你选择的法师子职业。塑能师子职业的详细内容见本职业说明之后。\n子职业是一种专精方向，会在特定的法师等级给予你特性。在此后的冒险生涯中，凡是等级不高于你法师等级的子职业特性，你都会获得。"
 },
 "wizard-ability-score-improvement": {
  "key": "wizard-ability-score-improvement",
  "name": "属性值提升",
  "text": "你获得属性值提升专长（见「专长」章节），或另一个你选择且符合条件的专长。"
 },
 "wizard-memorize-spell": {
  "key": "wizard-memorize-spell",
  "name": "记忆法术",
  "text": "每当你完成一次短休时，你可以研读你的法术书，把你通过施法特性准备的一个 1 环及以上的法师法术，替换为法术书中另一个 1 环及以上的法术。"
 },
 "berserker-frenzy": {
  "key": "berserker-frenzy",
  "name": "狂怒",
  "text": "如果你在狂暴持续期间使用鲁莽攻击，你在自己回合中用基于力量的攻击命中的第一个目标会受到额外伤害。额外伤害的计算方式是：掷数量等于你狂暴伤害加值的 d6，并把结果相加。这项伤害的类型与这次攻击所用的武器或徒手打击的伤害类型相同。"
 },
 "berserker-mindless-rage": {
  "key": "berserker-mindless-rage",
  "name": "无我狂暴",
  "text": "狂暴时，你无法被魅惑或恐惧。如果你在狂暴开始时已处于魅惑或恐惧状态，该状态在你狂暴期间被压制。"
 },
 "berserker-intimidating-presence": {
  "key": "berserker-intimidating-presence",
  "name": "威慑之姿",
  "text": "你可以用一个动作让周围 30 尺内一个能看见或听见你的生物进行一次感知豁免（DC 8 + 你的熟练加值 + 你的魅力调整值）。失败则它对你恐惧，直到你下一回合结束。"
 },
 "berserker-retaliation": {
  "key": "berserker-retaliation",
  "name": "报偿",
  "text": "第 14 级起，身边 5 尺内敌人对你造成伤害时，你可以用响应对该生物发动一次近战武器攻击。"
 },
 "totem-spirit-seeker": {
  "key": "totem-spirit-seeker",
  "name": "精魄寻者",
  "text": "你追求融入自然之道，与动物为友。在你选择此道途的第 3 级时，你获得以仪式施法方式施展法术野兽知觉和与动物交谈的能力。"
 },
 "totem-spirit": {
  "key": "totem-spirit",
  "name": "图腾精魄",
  "text": "在你选择此道途的第 3 级时，选择一个图腾精魄并获得其能力。你必须制造或获取一个象征图腾兽的毛、羽、爪、牙或骨的图腾物件，可以是项链，也可以是其他类似的物件。如果你愿意，你的外貌也会发生些微改变，让人看到时不由得联想起你的图腾精魄。你可以选择熊、鹰、狼，或是其他更适合你故乡环境的类似动物。"
 },
 "totem-aspect-of-the-beast": {
  "key": "totem-aspect-of-the-beast",
  "name": "兽之形",
  "text": "你获得一个与你图腾精魄相符的仪式能力：熊——你的载重翻倍，力量检定推、拉、举重时具有优势；鹰——你能看清 1 里内的细节，昏暗光线下也能正常视物；狼——你能以正常速度追踪，并识别走过的生物。"
 },
 "totem-spirit-walker": {
  "key": "totem-spirit-walker",
  "name": "精魄行者",
  "text": "你可以用仪式施法方式施展「与自然沟通」。施展时，你可以向自然之灵询问你周围 5 里内的一处地点、生物或事件。"
 },
 "totem-totemic-attunement": {
  "key": "totem-totemic-attunement",
  "name": "图腾同调",
  "text": "你获得一个与你图腾精魄相符的战斗能力：熊——狂暴时，距离你 5 尺内的敌对生物会优先攻击你；鹰——狂暴时，你能以附赠动作疾走，且从高处俯冲攻击时额外造成伤害；狼——狂暴时，你能以附赠动作撞倒一个大型或更小的生物。"
 },
 "lore-bonus-proficiencies": {
  "key": "lore-bonus-proficiencies",
  "name": "额外熟练",
  "text": "你获得三项你选择的技能的熟练。"
 },
 "lore-cutting-words": {
  "key": "lore-cutting-words",
  "name": "刻薄言辞",
  "text": "你学会用机智的言辞以超自然的方式分散他人的注意、扰乱他们的思绪，或以其他方式削弱他们的信心和能力。当你周围 60 尺内一个你能看见的生物进行伤害掷骰，或在属性检定或攻击检定中成功时，你可以用一个反应消耗一次诗人激励的使用次数：掷你的诗人激励骰，从该生物的掷骰结果中减去掷出的数字，从而减少伤害，或有可能让成功变成失败。"
 },
 "valor-bonus-proficiencies": {
  "key": "valor-bonus-proficiencies",
  "name": "附赠熟练项",
  "text": "你获得中甲、盾牌和军用武器的熟练项。"
 },
 "valor-combat-inspiration": {
  "key": "valor-combat-inspiration",
  "name": "战斗激励",
  "text": "从你身上获得诗人激励的生物投掷武器伤害掷骰时，可以使用该激励骰并将其骰值加入本次伤害掷骰中。另外，该生物被攻击时，可以用反应使用该激励骰，并把结果加到它对抗该次攻击的 AC 中。该特性可以在攻击检定揭示后使用，但必须在命中与否宣布之前。"
 },
 "valor-extra-attack": {
  "key": "valor-extra-attack",
  "name": "额外攻击",
  "text": "第 6 级起，你在自己回合内执行攻击动作时可以攻击两次而非一次。"
 },
 "valor-battle-magic": {
  "key": "valor-battle-magic",
  "name": "战斗魔法",
  "text": "第 14 级起，你可以自如地同时使用音乐魔法和武器。每当你用动作施展一个诗人法术时，你同时还可以用附赠动作发动一次武器攻击。"
 },
 "lore-additional-magical-secrets": {
  "key": "lore-additional-magical-secrets",
  "name": "额外魔法奥秘",
  "text": "你从任意职业的法术列表里选择两个法术加入已知法术中。你选择的法术必须是你当前等级可以施展的环阶或戏法。所选法术对你而言视为吟游诗人法术，但不包含在「诗人职业表」上「已知法术」一栏所记录的数量之内。"
 },
 "lore-peerless-skill": {
  "key": "lore-peerless-skill",
  "name": "超凡技艺",
  "text": "第 14 级起，你进行属性检定时，可以花费一次诗人激励次数并掷一次激励骰，然后将结果加到你的属性检定上。"
 },
 "life-disciple-of-life": {
  "key": "life-disciple-of-life",
  "name": "生命门徒",
  "text": "当你用法术位施展的法术为一个生物恢复生命值时，该生物在你施展该法术的那个回合额外恢复一些生命值。额外恢复的生命值等于 2 + 该法术位的环阶。"
 },
 "life-domain-spells": {
  "key": "life-domain-spells",
  "name": "生命领域法术",
  "text": "你与生命领域的联系确保你总有某些法术随时可用。达到表中指定的牧师等级时，你从此始终准备着这些法术。\n1 级：祝福术、疗伤术\n3 级：次级复原术、灵体武器\n5 级：希望信标、回生术\n7 级：防死结界、信仰守卫\n9 级：群体疗伤术、死者复活"
 },
 "life-preserve-life": {
  "key": "life-preserve-life",
  "name": "引导神力：维持生命",
  "text": "第 2 级起，你用一个动作展示圣徽，引导治疗能量恢复等于你牧师等级五倍的生命值。你指定身边 30 尺内的任意生物作为目标，再为其分配治疗能量。该特性不能把目标恢复到其生命值上限的一半以上，也不能对不死生物或构装生物使用。"
 },
 "land-circle-of-the-land-spells": {
  "key": "land-circle-of-the-land-spells",
  "name": "大地结社法术",
  "text": "每当你完成一次长休时，选择一种地貌：干旱、极地、温带或热带。查阅下面与所选地貌对应的表格；表中列在你的德鲁伊等级及更低等级的法术，你都已准备好。\n干旱地貌：\n3 级：《朦胧术》《燃烧之手》《火焰箭》\n5 级：《火球术》\n7 级：《枯萎术》\n9 级：《石墙术》\n极地地貌：\n3 级：《云雾术》《人类定身术》《冷冻射线》\n5 级：《雨夹雪》\n7 级：《冰风暴》\n9 级：《寒冰锥》\n温带地貌：\n3 级：《迷踪步》《电爪》《睡眠术》\n5 级：《闪电束》\n7 级：《行动自如》\n9 级：《树跃术》\n热带地貌：\n3 级：《酸液飞溅》《致病射线》《蛛网术》\n5 级：《臭云术》\n7 级：《变形术》\n9 级：《疫病虫群》"
 },
 "land-lands-aid": {
  "key": "land-lands-aid",
  "name": "大地之助",
  "text": "你可以以一个魔法动作消耗一次荒野变形的使用次数，并选择你周围 60 尺内的一个点。以该点为中心、半径 10 尺的球形区域内，会短暂地出现赋予活力的花朵和汲取生命的荆棘。球形区域内由你选择的每个生物都必须对抗你的法术豁免 DC 进行一次体质豁免，豁免失败时受到 2d6 暗蚀伤害，豁免成功时伤害减半。该区域内一个由你选择的生物恢复 2d6 生命值。\n"
 },
 "champion-improved-critical": {
  "key": "champion-improved-critical",
  "name": "强化重击",
  "text": "你用武器和徒手打击进行的攻击检定，在 d20 掷出 19 或 20 时都能造成重击。"
 },
 "champion-remarkable-athlete": {
  "key": "champion-remarkable-athlete",
  "name": "非凡健将",
  "text": "得益于你的运动天赋，你的先攻掷骰和力量（运动）检定具有优势。\n此外，在你造成一次重击之后，你可以立即移动最多等于你速度一半的距离，且不会引发借机攻击。"
 },
 "open-hand-technique": {
  "key": "open-hand-technique",
  "name": "散打技法",
  "text": "每当你用疾风连击给予的攻击命中一个生物时，你可以对该目标施加下列效果之一。\n扰乱。目标在它的下个回合开始前不能进行借机攻击。\n推离。目标必须在一次力量豁免中成功，否则被推离你最多 15 尺。\n击倒。目标必须在一次敏捷豁免中成功，否则陷入倒地状态。"
 },
 "devotion-oath-of-devotion-spells": {
  "key": "devotion-oath-of-devotion-spells",
  "name": "奉献之誓法术",
  "text": "你誓言的魔法确保你总有某些法术随时可用：当你达到奉献之誓法术表中指定的圣武士等级时，你从此始终准备着表中列出的法术。\n奉献之誓法术表：\n3 级：《防护善恶》《虔诚护盾》\n5 级：《援助术》《诚实之域》\n9 级：《希望信标》《解除魔法》\n13 级：《行动自如》《信仰守卫》\n17 级：《通神术》《焰击术》"
 },
 "devotion-sacred-weapon": {
  "key": "devotion-sacred-weapon",
  "name": "神圣武器",
  "text": "当你执行攻击动作时，你可以消耗一次引导神力的使用次数，为你手持的一把近战武器注入正能量。在 10 分钟内，或直到你再次使用这项特性为止，你用这把武器进行的攻击检定加上你的魅力调整值（加值最少 +1），并且每次用它命中时，你可以让它造成其正常类型的伤害或光耀伤害。\n这把武器还会发出半径 20 尺的明亮光照，并在此范围之外再发出 20 尺的微光。\n你可以提前结束这个效果（不需要动作）。如果你没有携带这把武器，这个效果也会结束。"
 },
 "hunter-hunters-lore": {
  "key": "hunter-hunters-lore",
  "name": "猎人学识",
  "text": "你能借助自然之力揭示猎物的某些长处和弱点。当一个生物被你的《猎人印记》标记时，你知道该生物是否具有任何免疫、抗性或易伤；如果有，你也知道具体是哪些。"
 },
 "hunter-hunters-prey": {
  "key": "hunter-hunters-prey",
  "name": "猎人猎物",
  "text": "你获得下列特性选项之一，由你选择。每当你完成一次短休或长休时，你可以把所选的选项换成另一个。\n巨像杀手。你的坚韧能拖垮哪怕最顽强的敌人。当你用武器命中一个生物时，如果目标已经损失了任何生命值，这把武器对它额外造成 1d8 伤害。你每回合只能造成一次这种额外伤害。\n破阵者。在你的每个回合中限一次，当你用武器进行一次攻击时，你可以用同一把武器对另一个生物再进行一次攻击；该生物必须位于原目标 5 尺内、在这把武器的攻击范围内，并且是你本回合还没有攻击过的。"
 },
 "thief-fast-hands": {
  "key": "thief-fast-hands",
  "name": "快手",
  "text": "你可以以一个附赠动作做下列事情之一。\n巧手。进行一次敏捷（巧手）检定，用盗贼工具开锁或解除陷阱，或者扒窃。\n使用物品。执行使用动作，或者执行魔法动作来使用一件需要该动作的魔法物品。"
 },
 "thief-second-story-work": {
  "key": "thief-second-story-work",
  "name": "飞檐走壁",
  "text": "你受过专门训练，能进入特别难以到达的地方，并因此获得下列好处。\n攀爬者。你获得等于你速度的攀爬速度。\n跳跃者。你可以用敏捷而不是力量来决定你的跳跃距离。"
 },
 "draconic-sorcery-draconic-resilience": {
  "key": "draconic-sorcery-draconic-resilience",
  "name": "龙族韧性",
  "text": "你体内的魔法显现出你龙族天赋的身体特征。你的生命值上限增加 3，并且此后你每获得一个术士等级，它就再增加 1。\n你身体的部分地方也覆盖着龙一般的鳞片。当你没有穿着护甲时，你的基础护甲等级等于 10 + 你的敏捷调整值 + 你的魅力调整值。"
 },
 "draconic-sorcery-draconic-spells": {
  "key": "draconic-sorcery-draconic-spells",
  "name": "龙族法术",
  "text": "当你达到龙族法术表中指定的术士等级时，你从此始终准备着表中列出的法术。\n龙族法术表：\n3 级：《变身术》《繁彩球》《命令术》《龙息术》\n5 级：《恐惧术》《飞行术》\n7 级：《秘法眼》《魅惑怪物》\n9 级：《通晓传奇》《召唤龙》"
 },
 "fiend-patron-dark-ones-blessing": {
  "key": "fiend-patron-dark-ones-blessing",
  "name": "黑暗者祝福",
  "text": "当你把一个敌人的生命值降到 0 时，你获得等于你魅力调整值 + 你邪术师等级的临时生命值（最少 1 点临时生命值）。如果别人把你周围 10 尺内一个敌人的生命值降到 0，你也获得这项好处。"
 },
 "fiend-patron-fiend-spells": {
  "key": "fiend-patron-fiend-spells",
  "name": "邪魔法术",
  "text": "你宗主的魔法确保你总有某些法术随时可用：当你达到邪魔法术表中指定的邪术师等级时，你从此始终准备着表中列出的法术。\n邪魔法术表：\n3 级：《燃烧之手》《命令术》《灼热射线》《暗示术》\n5 级：《火球术》《臭云术》\n7 级：《火焰护盾》《火墙术》\n9 级：《指使术》《疫病虫群》"
 },
 "evoker-evocation-savant": {
  "key": "evoker-evocation-savant",
  "name": "塑能专家",
  "text": "选择两个塑能学派的法师法术，每个都不得高于 2 环，免费把它们加入你的法术书。\n此外，每当你在本职业中获得一个新环阶的法术位时，你可以免费把一个塑能学派的法师法术加入你的法术书。所选法术必须是你拥有法术位的环阶。"
 },
 "evoker-potent-cantrip": {
  "key": "evoker-potent-cantrip",
  "name": "强力戏法",
  "text": "你造成伤害的戏法，连避开了主要冲击的生物也能波及。当你对一个生物施展戏法，而你的攻击检定未命中或目标在对抗该戏法的豁免中成功时，目标受到该戏法一半的伤害（如果有伤害的话），但不会受到该戏法的其他效果影响。"
 }
};

export const INVOCATIONS: OptionData[] = [
 {
  "key": "agonizing-blast",
  "name": "苦痛魔能",
  "text": "前提：2 级及以上邪术师，会一个能造成伤害的邪术师戏法。\n选择一个你已知且能造成伤害的邪术师戏法。你可以把你的魅力调整值加到该法术的伤害掷骰上。\n可重复：你可以多次获得这个祈唤，每次选择一个不同的符合条件的戏法。",
  "level": 2,
  "requires": "damage-cantrip",
  "repeatable": true
 },
 {
  "key": "armor-of-shadows",
  "name": "暗影护甲",
  "text": "你可以不消耗法术位，对自己施展《法师护甲》。",
  "level": 1
 },
 {
  "key": "ascendant-step",
  "name": "凌空步",
  "text": "前提：5 级及以上邪术师。\n你可以不消耗法术位，对自己施展《浮空术》。",
  "level": 5
 },
 {
  "key": "devils-sight",
  "name": "魔鬼视界",
  "text": "前提：2 级及以上邪术师。\n在你周围 120 尺内，无论是魔法的还是非魔法的微光和黑暗，你都能在其中正常视物。",
  "level": 2
 },
 {
  "key": "eldritch-mind",
  "name": "魔能心智",
  "text": "你为维持专注而进行的体质豁免具有优势。",
  "level": 1
 },
 {
  "key": "eldritch-smite",
  "name": "魔能斩",
  "text": "前提：5 级及以上邪术师，魔刃契约祈唤。\n每回合限一次，当你用契约武器命中一个生物时，你可以消耗一个契约魔法法术位，对目标额外造成 1d8 力场伤害，该法术位每有一环再加 1d8；如果目标的体型为巨型或更小，你还可以让它陷入倒地状态。",
  "level": 5,
  "requires": "pact-of-the-blade"
 },
 {
  "key": "eldritch-spear",
  "name": "魔能之矛",
  "text": "前提：2 级及以上邪术师，会一个能造成伤害的邪术师戏法。\n选择一个你已知、能造成伤害且射程至少 10 尺的邪术师戏法。当你施展该法术时，它的射程增加，增加的尺数等于你邪术师等级的 30 倍。\n可重复：每次选择一个不同的符合条件的戏法。",
  "level": 2,
  "requires": "damage-cantrip",
  "repeatable": true
 },
 {
  "key": "fiendish-vigor",
  "name": "邪魔活力",
  "text": "前提：2 级及以上邪术师。\n你可以不消耗法术位，对自己施展《虚假生命》。用这项特性施展该法术时，你不必为临时生命值掷骰，而是自动取骰子的最大值。",
  "level": 2
 },
 {
  "key": "gaze-of-two-minds",
  "name": "双心凝视",
  "text": "前提：5 级及以上邪术师。\n你可以用一个附赠动作触碰一个自愿的生物，并通过它的感官进行感知，直到你的下个回合结束。只要该生物和你位于同一个存在位面，你就可以在之后的回合中用一个附赠动作维持这一联系，把持续时间延长到你的下个回合结束。如果你没有以这种方式维持，联系就会结束。当你通过另一个生物的感官感知时，你能受益于该生物拥有的任何特殊感官；并且如果你们两者相距不超过 60 尺，你施展法术时可以视作你位于自己的空间，也可以视作你位于该生物的空间。",
  "level": 5
 },
 {
  "key": "gift-of-the-depths",
  "name": "深海之赐",
  "text": "前提：5 级及以上邪术师。\n你能在水下呼吸，并获得等于你速度的游泳速度。你还可以不消耗法术位施展《水下呼吸》一次，并在完成一次长休时恢复以这种方式施展它的能力。",
  "level": 5
 },
 {
  "key": "investment-of-the-chain-master",
  "name": "链主赋能",
  "text": "前提：5 级及以上邪术师，魔链契约祈唤。\n当你施展《寻获魔宠》时，你为召来的魔宠注入一部分你的魔能之力，赋予它下列好处。\n空中或水中：魔宠获得 40 尺的飞行速度或游泳速度（由你选择）。\n快速攻击：你可以用一个附赠动作命令魔宠执行攻击动作。\n暗蚀或光耀伤害：每当魔宠造成钝击、穿刺或挥砍伤害时，你可以让它改为造成暗蚀或光耀伤害。\n你的豁免 DC：如果魔宠迫使一个生物进行豁免检定，它使用你的法术豁免 DC。\n抗性：当魔宠受到伤害时，你可以用一个反应，让它获得对这次伤害的抗性。",
  "level": 5,
  "requires": "pact-of-the-chain"
 },
 {
  "key": "lessons-of-the-first-ones",
  "name": "太古者教诲",
  "text": "前提：2 级及以上邪术师。\n你从多元宇宙中一个古老的存在那里得到了知识，让你获得一个你选择的起源专长。\n可重复：你可以多次获得这个祈唤，每次选择一个不同的起源专长。",
  "level": 2,
  "repeatable": true
 },
 {
  "key": "mask-of-many-faces",
  "name": "千面面具",
  "text": "前提：2 级及以上邪术师。\n你可以不消耗法术位施展《易容术》。",
  "level": 2
 },
 {
  "key": "master-of-myriad-forms",
  "name": "万形之主",
  "text": "前提：5 级及以上邪术师。\n你可以不消耗法术位施展《变身术》。",
  "level": 5
 },
 {
  "key": "misty-visions",
  "name": "迷雾幻象",
  "text": "前提：2 级及以上邪术师。\n你可以不消耗法术位施展《无声幻影》。",
  "level": 2
 },
 {
  "key": "one-with-shadows",
  "name": "与影合一",
  "text": "前提：5 级及以上邪术师。\n当你位于微光或黑暗区域中时，你可以不消耗法术位，对自己施展《隐形术》。",
  "level": 5
 },
 {
  "key": "otherworldly-leap",
  "name": "异界飞跃",
  "text": "前提：2 级及以上邪术师。\n你可以不消耗法术位，对自己施展《跳跃术》。",
  "level": 2
 },
 {
  "key": "pact-of-the-blade",
  "name": "魔刃契约",
  "text": "你可以以一个附赠动作在手中召出一把契约武器（一把由你选择、与你缔结联结的简易或军用近战武器），或者与你触碰的一把魔法武器缔结联结；如果有别人与一把魔法武器同调，或另一名邪术师已与它缔结联结，你就不能与它缔结联结。在联结结束之前，你熟练这把武器，并且可以把它当作施法法器。每当你用这把缔结联结的武器攻击时，你可以用魅力调整值代替力量或敏捷进行攻击检定和伤害掷骰；你还可以让这把武器造成暗蚀、心灵或光耀伤害，或者造成其正常类型的伤害。如果你再次使用这项特性的附赠动作、这把武器离你超过 5 尺达 1 分钟或更久，或者你死亡，你与这把武器的联结就会结束。召出的武器在联结结束时消失。",
  "level": 1
 },
 {
  "key": "pact-of-the-chain",
  "name": "魔链契约",
  "text": "你学会《寻获魔宠》法术，并且可以以一个魔法动作、不消耗法术位施展它。施展这个法术时，你可以为魔宠选择一种普通形态，或者下列特殊形态之一：小恶魔、伪龙、夸塞魔、骷髅、奇迹斯芬克斯、小妖精或毒蛇。此外，当你执行攻击动作时，你可以放弃自己的一次攻击，让你的魔宠用它的反应进行一次它自己的攻击。",
  "level": 1
 },
 {
  "key": "pact-of-the-tome",
  "name": "魔典契约",
  "text": "你把缕缕阴影编织在一起，在一次短休或长休结束时于手中召出一本书。这本暗影之书（外观由你决定）蕴含着只有你能取用的魔能魔法。书出现时，选择三个戏法，以及两个具有仪式标签的 1 环法术。这些法术可以来自任何职业的法术列表，但必须是你尚未准备的法术。当这本书在你身上时，你已准备好所选的法术，并且它们对你来说算作邪术师法术。你可以把这本书当作施法法器。如果你再次用这项特性召出一本书，之前的那本就会消失；你死亡时这本书也会消失。",
  "level": 1
 },
 {
  "key": "repelling-blast",
  "name": "推斥魔能",
  "text": "前提：2 级及以上邪术师，会一个通过攻击检定造成伤害的邪术师戏法。\n选择一个你已知且需要进行攻击检定的邪术师戏法。当你用该戏法命中一个体型为大型或更小的生物时，你可以把该生物沿直线推离你最多 10 尺。\n可重复：每次选择一个不同的符合条件的戏法。",
  "level": 2,
  "requires": "attack-cantrip",
  "repeatable": true
 },
 {
  "key": "thirsting-blade",
  "name": "渴血魔刃",
  "text": "前提：5 级及以上邪术师，魔刃契约祈唤。\n你获得额外攻击特性，但只能用于你的契约武器。借助这项特性，当你在自己的回合执行攻击动作时，你可以用这把武器攻击两次，而不是一次。",
  "level": 5,
  "requires": "pact-of-the-blade"
 }
];

export const METAMAGIC: OptionData[] = [
 {
  "key": "careful-spell",
  "name": "谨慎法术",
  "text": "消耗：1 术法点。\n当你施展一个迫使其他生物进行豁免检定的法术时，你可以保护其中一些生物免受法术的全部威力。为此，花费 1 术法点，并从这些生物中选择最多等于你魅力调整值数量的生物（最少一个）。被选中的生物对该法术的豁免检定自动成功，并且如果它通常在豁免成功时受到一半伤害，它改为不受伤害。",
  "cost": 1
 },
 {
  "key": "distant-spell",
  "name": "远程法术",
  "text": "消耗：1 术法点。\n当你施展一个射程至少 5 尺的法术时，你可以花费 1 术法点，让该法术的射程翻倍。或者，当你施展一个射程为触碰的法术时，你可以花费 1 术法点，让该法术的射程变为 30 尺。",
  "cost": 1
 },
 {
  "key": "empowered-spell",
  "name": "强效法术",
  "text": "消耗：1 术法点。\n当你为一个法术掷伤害时，你可以花费 1 术法点，重掷最多等于你魅力调整值数量的伤害骰（最少一枚），并且必须使用新的掷骰结果。即使你在施展这个法术时已经使用了另一个超魔选项，你仍然可以使用强效法术。",
  "cost": 1
 },
 {
  "key": "extended-spell",
  "name": "延效法术",
  "text": "消耗：1 术法点。\n当你施展一个持续时间为 1 分钟或更长的法术时，你可以花费 1 术法点，让它的持续时间翻倍，但最多为 24 小时。如果受影响的法术需要专注，你为维持这个专注而进行的豁免检定具有优势。",
  "cost": 1
 },
 {
  "key": "heightened-spell",
  "name": "升阶法术",
  "text": "消耗：2 术法点。\n当你施展一个迫使生物进行豁免检定的法术时，你可以花费 2 术法点，让该法术的一个目标在对抗该法术的豁免中具有劣势。",
  "cost": 2
 },
 {
  "key": "quickened-spell",
  "name": "瞬发法术",
  "text": "消耗：2 术法点。\n当你施展一个施法时间为一个动作的法术时，你可以花费 2 术法点，把这次施法的施法时间改为一个附赠动作。如果你在当前回合已经施展过 1 环及以上的法术，你就不能以这种方式调整法术；以这种方式调整一个法术之后，你在本回合也不能再施展 1 环及以上的法术。",
  "cost": 2
 },
 {
  "key": "seeking-spell",
  "name": "追踪法术",
  "text": "消耗：1 术法点。\n如果你为一个法术进行攻击检定而未命中，你可以花费 1 术法点重掷这枚 d20，并且必须使用新的结果。即使你在施展这个法术时已经使用了另一个超魔选项，你仍然可以使用追踪法术。",
  "cost": 1
 },
 {
  "key": "subtle-spell",
  "name": "精妙法术",
  "text": "消耗：1 术法点。\n当你施展一个法术时，你可以花费 1 术法点，在不需要任何言语、姿势或材料成分的情况下施展它；但会被该法术消耗的材料成分，以及法术中注明了价格的材料成分除外。",
  "cost": 1
 },
 {
  "key": "transmuted-spell",
  "name": "转化法术",
  "text": "消耗：1 术法点。\n当你施展一个造成下列某种类型伤害的法术时，你可以花费 1 术法点，把该伤害类型改为列表中的另一种类型：强酸、冷冻、火焰、闪电、毒素、雷鸣。",
  "cost": 1
 },
 {
  "key": "twinned-spell",
  "name": "孪生法术",
  "text": "消耗：1 术法点。\n当你施展一个能通过使用更高环的法术位来额外指定一个生物为目标的法术（比如《魅惑人类》）时，你可以花费 1 术法点，让该法术的有效环阶提高 1 环。",
  "cost": 1
 }
];
