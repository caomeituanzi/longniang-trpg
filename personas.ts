// AI 角色（V1.1.0，「AI 大厅」）：玩家自己做的陪玩 AI——名字、简介、人设（提示词）。
// 作者选公开（放进 AI 大厅，谁都能看人设、能邀请）还是不公开（只有作者自己能邀请）。
// 房主把没人选的身份交给某个 AI 角色：开局以后它每一轮照人设、只用自己的角色知道的事交行动，和大家的行动一起结算。
// 作者还可以给它做一张 5E 角色卡（Persona5e）：请进 5E 对局时按这张卡算种族、职业、生命值、AC 和法术。

import type { Identity } from './admin';
import type { Card5eData } from './5e/types';

/** 名字最多几个字（和角色名、AI 队友的名字一样）。 */
export const PERSONA_NAME_MAX = 20;
/** 简介最多几个字：大厅的卡片上、对局里给大家看的一句话。 */
export const PERSONA_INTRO_MAX = 100;
/** 人设最多几个字。 */
export const PERSONA_PROMPT_MAX = 1000;
/** 每个账号最多做几个 AI 角色。 */
export const PERSONAS_MAX = 20;
/** 大厅一页列几个。 */
export const PERSONA_PAGE = 30;

export type PersonaSort = 'popular' | 'new';

export type PersonaAuthor = { publicId: string; displayName: string; avatar: string | null; identity: Identity; frame: string | null };

/** AI 角色带的 5E 角色卡（作者选了「5E 角色卡」才有）：卡上的选择、外貌、背景故事。名字用 AI 角色的名字。 */
export type Persona5e = {
  data: Card5eData;
  appearance: string;
  background: string;
};

/** 大厅卡片上给人看的 5E 一句话。 */
export type Persona5eSummary = {
  speciesName: string;
  className: string;
  subclassName: string | null;
  level: number;
  hpMax: number;
  ac: number;
  /** 「人类 战士 1 级 · HP 12 · AC 16」 */
  line: string;
};

export type PersonaView = {
  id: number;
  name: string;
  intro: string;
  /** 人设：公开的谁都看得到；不公开的只有作者自己（和管理员）看得到，别人拿到的是空的。 */
  prompt: string;
  public: boolean;
  author: PersonaAuthor;
  /** 自己做的。 */
  mine: boolean;
  /** 被请进过几局。 */
  invites: number;
  /** 5E 角色卡（没选是 null）。 */
  card5e: Persona5e | null;
  /** 5E 角色卡的一句话，给大厅卡片看。 */
  card5eSummary: Persona5eSummary | null;
  createdAt: number;
  updatedAt: number;
};

/** 对局里交给 AI 角色的身份（GameState.companions）：请进来时的名字、简介和作者。id 是大厅里的编号（删掉了、不公开又不是自己的是 null）。 */
export type PersonaBrief = { id: number | null; name: string; intro: string; author: string };

/** 大厅里邀请一个 AI 角色时，能请它进去的对局：自己当房主、在开团准备、还有身份能交给 AI 的。 */
export type PersonaInviteRoom = {
  roomId: number;
  name: string;
  scenarioTitle: string;
  roles: { key: string; name: string; public: string; ai: string | null }[];
};
