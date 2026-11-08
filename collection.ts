import { transaction, type DB } from './db';
import {
  HIDDEN_ACHIEVEMENTS,
  hiddenAchievementOf,
  OLD_FRIENDS_GAMES,
  POPULAR_VISITS,
  REGULAR_GAMES,
  RICH_CRYSTALS,
  SMOOTH_ROLLS,
  SPEEDRUN_MS,
  type AnyAchievementKey,
} from './hidden-achievements';
import { addCrystals, crystalsOf, type FinishedGame } from './pets';
import { CONSUMABLE_KEYS } from '../shared/rules2';
import { GEAR_BASES } from '../shared/gear2';
import { LEGENDARY_GEAR } from './legendary';
import { MANUAL_PREFIX, SKILLS } from './skills';
import type { Social } from './social';
import { ACHIEVEMENTS, achievementOf, type CollectionBook, type EarnedAchievement } from '../shared/achievements';
import { ACHIEVEMENT_REWARD, ENDING_REWARD, PET_SHOP } from '../shared/pets';
import { ALL_PLACES, FAR, NEAR } from '../shared/postcards';
import { TRACK_MAX } from '../shared/rules';

/** 成就的定义：普通的和隐藏的。 */
function definitionOf(key: string) {
  return achievementOf(key) ?? hiddenAchievementOf(key);
}

// 结局图鉴和成就（V0.6.0）。
// 结局图鉴：玩完剧本大厅里的剧本（算玩完的人，见 pets.growFromGame），记下达成的结局，第一次达成某个结局给龙晶。
// 成就：达成时记下、给龙晶、发通知，得到同名的称号（称号能在个人主页上戴）。每个成就只算一次；
// 大部分按记录现查（达成的条件到了再查一遍就行），带宠物玩完、心如止水、宠物转败为胜这几个在发生的那一刻直接给。
// 隐藏成就（server/hidden-achievements.ts）也一样，只是网页上没达成的只显示「？？？」。

/** 一次结算里的检定（成就要用的部分）。petSaved：宠物出手，把失败变成了成功。 */
export type CommittedRoll = { characterId: number; outcome: string; hidden: boolean; petSaved: boolean };

export class Collection {
  constructor(
    private readonly opts: {
      db: DB;
      social: Social;
      now: () => number;
      /** 剧本大厅里一个剧本的全部结局（剧本不在了是 null）。 */
      scenarioEndings: (key: string) => { key: string; title: string }[] | null;
      /** 剧本大厅里现在有的剧本（图鉴用）。 */
      hallScenarios?: () => { key: string; title: string }[];
      /** 隐藏成就开不开（默认开；测试默认关，见 AppOptions.hiddenAchievements）。 */
      hidden?: boolean;
    },
  ) {}

  /** 这个成就算不算（隐藏成就关掉的时候不算）。 */
  private enabled(key: string): boolean {
    return this.opts.hidden !== false || !hiddenAchievementOf(key);
  }

  private get db() {
    return this.opts.db;
  }

  private has(userId: number, key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM achievements WHERE user_id = ? AND key = ?').get(userId, key);
  }

  private count(sql: string, ...args: (number | string)[]): number {
    return (this.db.prepare(sql).get(...args) as { n: number }).n;
  }

  /** 这个成就的条件现在到了没有（按记录查；在发生时直接给的几个这里总是 false）。 */
  private met(userId: number, key: AnyAchievementKey): boolean {
    switch (key) {
      case 'first-game':
        return this.count('SELECT COUNT(*) AS n FROM pet_growth WHERE user_id = ?', userId) >= 1;
      case 'five-categories':
        return this.count('SELECT COUNT(DISTINCT attribute) AS n FROM pet_growth WHERE user_id = ? AND attribute IS NOT NULL', userId) >= 5;
      case 'endings-5':
        return this.count('SELECT COUNT(*) AS n FROM endings_reached WHERE user_id = ?', userId) >= 5;
      case 'all-endings': {
        const mine = this.db.prepare('SELECT scenario_key, COUNT(*) AS n FROM endings_reached WHERE user_id = ? GROUP BY scenario_key').all(userId) as {
          scenario_key: string;
          n: number;
        }[];
        return mine.some((m) => {
          const all = this.opts.scenarioEndings(m.scenario_key);
          if (!all?.length || m.n < all.length) return false;
          const got = new Set(
            (this.db.prepare('SELECT ending_key FROM endings_reached WHERE user_id = ? AND scenario_key = ?').all(userId, m.scenario_key) as { ending_key: string }[]).map(
              (r) => r.ending_key,
            ),
          );
          return all.every((e) => got.has(e.key));
        });
      }
      case 'crit-3':
        return (
          this.count(
            `SELECT COUNT(*) AS n FROM (SELECT r.room_id FROM rolls r JOIN characters c ON c.id = r.character_id JOIN players p ON p.id = c.player_id
             WHERE p.user_id = ? AND r.outcome = 'critical' AND r.hidden = 0 GROUP BY r.room_id HAVING COUNT(*) >= 3)`,
            userId,
          ) > 0
        );
      case 'fumble':
        return (
          this.count(
            `SELECT COUNT(*) AS n FROM rolls r JOIN characters c ON c.id = r.character_id JOIN players p ON p.id = c.player_id
             WHERE p.user_id = ? AND r.outcome = 'fumble' AND r.hidden = 0`,
            userId,
          ) > 0
        );
      case 'job-10':
        return this.count("SELECT COUNT(*) AS n FROM crystal_ledger WHERE user_id = ? AND kind = 'job'", userId) >= 10;
      case 'trip-5':
        return this.count("SELECT COUNT(*) AS n FROM pet_diary WHERE user_id = ? AND kind = 'postcard'", userId) >= 5;
      case 'visit-10':
        return this.count('SELECT COUNT(*) AS n FROM pet_visits WHERE visitor_id = ? AND rewarded = 1', userId) >= 10;
      case 'author':
        return this.count('SELECT COUNT(*) AS n FROM scenario_authors WHERE user_id = ?', userId) >= 1;
      case 'author-5':
        return this.count('SELECT COUNT(*) AS n FROM author_plays WHERE author_id = ?', userId) >= 5;
      case 'rater-3':
        return this.count('SELECT COUNT(*) AS n FROM scenario_ratings WHERE user_id = ?', userId) >= 3;
      // ---------- 隐藏成就 ----------
      case 'old-friends':
        // 和同一个人都算玩完了的局（pet_growth 一局一人一行）
        return (
          this.count(
            `SELECT COUNT(*) AS n FROM (SELECT o.user_id FROM pet_growth me JOIN pet_growth o
               ON o.room_id = me.room_id AND o.room_created_at = me.room_created_at AND o.user_id != me.user_id
             WHERE me.user_id = ? GROUP BY o.user_id HAVING COUNT(*) >= ?)`,
            userId,
            OLD_FRIENDS_GAMES,
          ) > 0
        );
      case 'postcards-all': {
        const places = new Set(
          (this.db.prepare("SELECT DISTINCT title FROM pet_diary WHERE user_id = ? AND kind = 'postcard'").all(userId) as { title: string }[]).map((r) => r.title),
        );
        return ALL_PLACES.every((place) => places.has(place));
      }
      case 'rich':
        return crystalsOf(this.db, userId) >= RICH_CRYSTALS;
      case 'popular-pet':
        return this.count('SELECT COUNT(*) AS n FROM pet_visits WHERE owner_id = ? AND visitor_id != owner_id AND rewarded = 1', userId) >= POPULAR_VISITS;
      case 'regular':
        return (
          this.count(
            'SELECT COUNT(*) AS n FROM (SELECT scenario_title FROM pet_growth WHERE user_id = ? GROUP BY scenario_title HAVING COUNT(*) >= ?)',
            userId,
            REGULAR_GAMES,
          ) > 0
        );
      default:
        return false;
    }
  }

  /** 查一遍这几个成就，到了的给上。 */
  check(userId: number, keys: AnyAchievementKey[]) {
    const user = this.db.prepare('SELECT is_guest, deleted_at FROM users WHERE id = ?').get(userId) as { is_guest: number; deleted_at: number | null } | undefined;
    if (!user || user.is_guest === 1 || user.deleted_at !== null) return;
    for (const key of keys) {
      if (this.enabled(key) && !this.has(userId, key) && this.met(userId, key)) this.unlock(userId, key);
    }
  }

  /** 给一个成就（已经有了就什么也不做）。key 不是成就列表里的（活动称号）要给 title、how。游客不给。 */
  unlock(userId: number, key: string, extra?: { title: string; how: string }) {
    if (!this.enabled(key)) return;
    const user = this.db.prepare('SELECT is_guest, deleted_at FROM users WHERE id = ?').get(userId) as { is_guest: number; deleted_at: number | null } | undefined;
    if (!user || user.is_guest === 1 || user.deleted_at !== null) return;
    const def = definitionOf(key);
    const title = extra?.title ?? def?.title;
    const how = extra?.how ?? def?.how ?? '';
    if (!title) return;
    const at = this.opts.now();
    const added = transaction(this.db, () => {
      const n = this.db.prepare('INSERT INTO achievements (user_id, key, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(userId, key, title, at).changes;
      if (n) addCrystals(this.db, userId, ACHIEVEMENT_REWARD, 'achievement', `成就「${title}」`, null, at);
      return n > 0;
    });
    if (added) {
      this.opts.social.notify(userId, 'achievement', { key, title, how, reward: ACHIEVEMENT_REWARD, ...(hiddenAchievementOf(key) ? { hidden: true } : {}) });
      // 成就给的龙晶也可能攒够了
      if (key !== 'rich') this.check(userId, ['rich']);
    }
  }

  /**
   * 一局走到结局以后：记下达成的结局（剧本大厅里的剧本才记），第一次达成的给龙晶；
   * 给带着宠物玩完、心如止水、活动称号这几个当场的成就，再查一遍和玩完剧本有关的成就。
   */
  afterGame(game: FinishedGame) {
    const at = this.opts.now();
    for (const p of game.players) {
      if (game.ending && game.scenarioKey) {
        const key = game.scenarioKey;
        const ending = game.ending;
        transaction(this.db, () => {
          const n = this.db
            .prepare(
              `INSERT INTO endings_reached (user_id, scenario_key, ending_key, ending_title, scenario_title, created_at)
               VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .run(p.userId, key, ending.key, ending.title, game.scenarioTitle, at).changes;
          if (n) addCrystals(this.db, p.userId, ENDING_REWARD, 'ending', `第一次达成《${game.scenarioTitle}》的结局「${ending.title}」`, null, at);
        });
      }
      this.check(p.userId, ['first-game', 'five-categories', 'endings-5', 'all-endings']);
      const c = this.db
        .prepare('SELECT c.id, c.stress, c.wounds, c.dead, c.pet FROM characters c JOIN players pl ON pl.id = c.player_id WHERE c.room_id = ? AND pl.user_id = ?')
        .get(game.roomId, p.userId) as { id: number; stress: number; wounds: number; dead: number; pet: string | null } | undefined;
      if (c?.pet) this.unlock(p.userId, 'with-pet');
      if (c && game.category === 'horror' && game.stress && c.stress === 0) this.unlock(p.userId, 'calm-horror');
      if (game.event?.title) {
        this.unlock(p.userId, `event-${game.event.id}`, { title: game.event.title, how: `${game.event.name}期间玩完活动分区的剧本` });
      }
      if (game.ending) this.hiddenAfterGame(p.userId, game, c ?? null, at);
      this.check(p.userId, ['old-friends', 'regular', 'rich']);
    }
  }

  /** 走到结局时的隐藏成就：几点玩完的、角色最后的样子、这一局的检定、多快走完。时间按服务器的钟。 */
  private hiddenAfterGame(userId: number, game: FinishedGame, c: { id: number; wounds: number; dead: number } | null, at: number) {
    const d = new Date(at);
    const hour = d.getHours();
    if (hour >= 2 && hour < 5) this.unlock(userId, 'night-owl');
    if (hour === 0 && game.category === 'horror') this.unlock(userId, 'midnight-horror');
    if (d.getMonth() === 9 && d.getDate() === 31) this.unlock(userId, 'halloween');
    if (c) {
      if (c.dead === 1) this.unlock(userId, 'sacrifice');
      else if (c.wounds >= TRACK_MAX) this.unlock(userId, 'last-breath');
      const rolls = this.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(outcome IN ('failure', 'fumble')), 0) AS failed FROM rolls WHERE room_id = ? AND character_id = ? AND hidden = 0`,
        )
        .get(game.roomId, c.id) as { n: number; failed: number };
      if (rolls.n >= SMOOTH_ROLLS && rolls.failed === 0) this.unlock(userId, 'smooth');
    }
    // 开场（第一段叙述）到走到结局不到一小时
    const opening = this.db
      .prepare(
        `SELECT MIN(created_at) AS at FROM log_entries WHERE room_id = ? AND kind = 'narration' AND created_at >= ? AND json_extract(data, '$.type') = 'opening'`,
      )
      .get(game.roomId, game.roomCreatedAt) as { at: number | null };
    if (opening.at !== null && at - opening.at < SPEEDRUN_MS) this.unlock(userId, 'speedrun');
  }

  /** 一次结算写进去以后：大成功、大失败、宠物转败为胜；隐藏的大起大落、祸不单行、神来一爪。 */
  afterResolution(rolls: CommittedRoll[]) {
    const users = new Map<number, { saved: boolean; petCrit: boolean; characters: Set<number> }>();
    for (const r of rolls) {
      const u = this.db.prepare('SELECT p.user_id FROM characters c JOIN players p ON p.id = c.player_id WHERE c.id = ?').get(r.characterId) as
        | { user_id: number }
        | undefined;
      if (!u) continue;
      const entry = users.get(u.user_id) ?? { saved: false, petCrit: false, characters: new Set<number>() };
      entry.saved ||= r.petSaved;
      entry.petCrit ||= r.petSaved && r.outcome === 'critical';
      entry.characters.add(r.characterId);
      users.set(u.user_id, entry);
    }
    for (const [userId, e] of users) {
      if (e.saved) this.unlock(userId, 'pet-save');
      if (e.petCrit) this.unlock(userId, 'pet-crit');
      this.check(userId, ['crit-3', 'fumble']);
      // 一个角色就是一局：这一局里掷出过几次大成功、大失败（暗骰不算）
      for (const characterId of e.characters) {
        const n = this.db
          .prepare(
            `SELECT COALESCE(SUM(outcome = 'critical'), 0) AS crit, COALESCE(SUM(outcome = 'fumble'), 0) AS fumble FROM rolls WHERE character_id = ? AND hidden = 0`,
          )
          .get(characterId) as { crit: number; fumble: number };
        if (n.crit > 0 && n.fumble > 0) this.unlock(userId, 'swing');
        if (n.fumble >= 2) this.unlock(userId, 'double-fumble');
      }
    }
  }

  /** 达成了的成就（新的在后）。隐藏成就标着 hidden（达成了才告诉网页名字和条件）。 */
  earned(userId: number): EarnedAchievement[] {
    return (this.db.prepare('SELECT key, title, created_at FROM achievements WHERE user_id = ? ORDER BY created_at, key').all(userId) as {
      key: string;
      title: string;
      created_at: number;
    }[]).map((r) => {
      const hidden = hiddenAchievementOf(r.key);
      return { key: r.key, title: r.title, how: definitionOf(r.key)?.how ?? '活动', at: r.created_at, ...(hidden ? { hidden: true } : {}) };
    });
  }

  /** 达成的结局一共几个。 */
  endingCount(userId: number): number {
    return this.count('SELECT COUNT(*) AS n FROM endings_reached WHERE user_id = ?', userId);
  }

  /** 一个剧本里我达成过的结局。 */
  reached(userId: number, scenarioKey: string): { key: string; title: string; at: number }[] {
    return (this.db
      .prepare('SELECT ending_key, ending_title, created_at FROM endings_reached WHERE user_id = ? AND scenario_key = ? ORDER BY created_at')
      .all(userId, scenarioKey) as { ending_key: string; ending_title: string; created_at: number }[]).map((r) => ({ key: r.ending_key, title: r.ending_title, at: r.created_at }));
  }

  /** 每个剧本我达成了几个结局：scenario_key → 个数。 */
  reachedCounts(userId: number): Map<string, number> {
    return new Map(
      (this.db.prepare('SELECT scenario_key, COUNT(*) AS n FROM endings_reached WHERE user_id = ? GROUP BY scenario_key').all(userId) as { scenario_key: string; n: number }[]).map(
        (r) => [r.scenario_key, r.n],
      ),
    );
  }

  // ==================== 图鉴 ====================

  /** 图鉴：结局（剧本大厅里的每个剧本）、去过的地方、装扮、骰子皮肤、成就。 */
  book(userId: number): CollectionBook {
    const owned = new Set(
      (this.db.prepare('SELECT item FROM pet_items WHERE user_id = ? AND count > 0').all(userId) as { item: string }[]).map((r) => r.item),
    );
    const endings = (this.opts.hallScenarios?.() ?? []).map((sc) => {
      const all = this.opts.scenarioEndings(sc.key) ?? [];
      const got = new Map(this.reached(userId, sc.key).map((r) => [r.key, r.title]));
      return { key: sc.key, title: sc.title, total: all.length, reached: all.filter((e) => got.has(e.key)).map((e) => ({ key: e.key, title: e.title })) };
    });
    const places = (this.db.prepare("SELECT DISTINCT title FROM pet_diary WHERE user_id = ? AND kind = 'postcard'").all(userId) as { title: string }[]).map((r) => r.title);
    return {
      endings,
      places,
      outfits: PET_SHOP.filter((i) => i.kind === 'outfit' && owned.has(i.key)).map((i) => i.key),
      dice: PET_SHOP.filter((i) => i.kind === 'dice' && owned.has(i.key)).map((i) => i.key),
      achievements: this.earned(userId),
    };
  }

  /**
   * 站长给自己全部解锁（测试用）：商城里吃的用的、装扮、头像框、骰子、称号每样在背包里放一个（已经有的不动）；
   * V0.7.0 起还有：地下城道具、每本秘籍、一个宝箱各一个，每种装备的每个稀有度（连传奇的）各一件；
   * 图鉴全开：所有结局、每个地方一张明信片、所有成就（隐藏的也给；成就照样记上，不发龙晶；结局也不发龙晶）。
   */
  unlockAll(userId: number) {
    const at = this.opts.now();
    transaction(this.db, () => {
      const put = this.db.prepare('INSERT INTO pet_items (user_id, item, count) VALUES (?, ?, 1) ON CONFLICT (user_id, item) DO UPDATE SET count = MAX(count, 1)');
      for (const i of PET_SHOP) put.run(userId, i.key);
      for (const key of [...CONSUMABLE_KEYS, ...SKILLS.map((k) => `${MANUAL_PREFIX}${k.key}`), 'chest']) put.run(userId, key);
      const gear = this.db.prepare("INSERT INTO gear_items (user_id, base, rarity, source, created_at) VALUES (?, ?, ?, 'unlock', ?) ON CONFLICT DO NOTHING");
      for (const b of GEAR_BASES) for (const r of ['common', 'fine', 'rare', 'epic'] as const) gear.run(userId, b.key, r, at);
      for (const g of LEGENDARY_GEAR) gear.run(userId, g.key, 'legendary', at);
      const ending = this.db.prepare(
        `INSERT INTO endings_reached (user_id, scenario_key, ending_key, ending_title, scenario_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const sc of this.opts.hallScenarios?.() ?? []) {
        for (const e of this.opts.scenarioEndings(sc.key) ?? []) ending.run(userId, sc.key, e.key, e.title, sc.title, at);
      }
      const visited = new Set(
        (this.db.prepare("SELECT DISTINCT title FROM pet_diary WHERE user_id = ? AND kind = 'postcard'").all(userId) as { title: string }[]).map((r) => r.title),
      );
      const pet = (this.db.prepare('SELECT name FROM pets WHERE user_id = ?').get(userId) as { name: string } | undefined)?.name ?? '宠物';
      const card = this.db.prepare("INSERT INTO pet_diary (user_id, kind, title, text, status, created_at) VALUES (?, 'postcard', ?, ?, 'done', ?)");
      for (const p of [...NEAR, ...FAR]) {
        if (!visited.has(p.place)) card.run(userId, p.place, p.lines[0].replaceAll('{pet}', pet), at);
      }
      const ach = this.db.prepare('INSERT INTO achievements (user_id, key, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
      for (const a of [...ACHIEVEMENTS, ...HIDDEN_ACHIEVEMENTS]) ach.run(userId, a.key, a.title, at);
    });
  }
}
