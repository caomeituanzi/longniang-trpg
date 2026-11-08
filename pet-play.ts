import { transaction, type DB } from './db';
import { HttpError } from './http';
import { addCrystals, type Pets } from './pets';
import { dayStart } from './util';
import type { Social } from './social';
import type { AnyAchievementKey } from './hidden-achievements';
import { PET_SHOP, VISIT_REWARD } from '../shared/pets';

// 宠物之间的事（V0.6.0）：串门（喂吃的、摸摸头）。宠物本身的状态、龙晶在 pets.ts。
// V0.7.0 去掉了宠物留言（pet_notes 表留着不用）和宠物排行（「排行」页改成作品、作者、角色）。
// 切磋 V0.7.0 改成角色卡对角色卡（宠物当帮手），见计划文档。

type Person = { id: number; public_id: string; display_name: string; avatar_at: number | null; is_guest: number; banned_at: number | null; deleted_at: number | null };

export class PetPlay {
  achievements?: { check(userId: number, keys: AnyAchievementKey[]): void };

  constructor(
    private readonly opts: {
      db: DB;
      social: Social;
      pets: Pets;
      now: () => number;
      /** 0～n-1 的随机整数（测试可以换掉）。 */
      rng: (n: number) => number;
    },
  ) {}

  private get db() {
    return this.opts.db;
  }

  /** 按公开编号找一个能打交道的人：正式账号、没被封、没删。 */
  private person(ref: string): Person {
    const row = this.db
      .prepare('SELECT id, public_id, display_name, avatar_at, is_guest, banned_at, deleted_at FROM users WHERE public_id = ? AND deleted_at IS NULL')
      .get(ref) as Person | undefined;
    if (!row || row.banned_at !== null || row.is_guest === 1) throw new HttpError(404, '没有这个用户');
    return row;
  }

  // ==================== 串门 ====================

  private visitedToday(visitorId: number, ownerId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM pet_visits WHERE visitor_id = ? AND owner_id = ? AND rewarded = 1 AND created_at >= ?')
      .get(visitorId, ownerId, dayStart(this.opts.now()));
  }

  /** 主页上的串门：好友才能串门；今天串过没有；我背包里能喂的吃的。不是好友是 null。 */
  visitInfo(visitorId: number, ownerId: number): { allowed: boolean; visitedToday: boolean; food: { key: string; name: string; count: number }[] } | null {
    if (visitorId === ownerId || !this.opts.pets.brief(ownerId)) return null;
    const allowed = this.opts.social.areFriends(visitorId, ownerId) && !this.opts.social.blockedEither(visitorId, ownerId);
    const items = this.opts.pets.items(visitorId);
    const food = Object.entries(items)
      .map(([key, count]) => ({ key, count, item: PET_FOOD.get(key) }))
      .filter((x) => x.item && x.count > 0)
      .map((x) => ({ key: x.key, name: x.item!, count: x.count }));
    return { allowed, visitedToday: this.visitedToday(visitorId, ownerId), food };
  }

  /** 串门：喂一口自己背包里的吃的（item）或者摸摸头。每天第一次串门同一只宠物，两边各得龙晶。 */
  visit(visitorId: number, ref: string, kind: 'feed' | 'pat', item: string | null): { pet: string; rewarded: number } {
    const owner = this.person(ref);
    if (owner.id === visitorId) throw new HttpError(400, '这是你自己的宠物，在「我的背包」里喂它就行');
    if (!this.opts.social.areFriends(visitorId, owner.id) || this.opts.social.blockedEither(visitorId, owner.id)) {
      throw new HttpError(403, '只能去好友家串门');
    }
    const pet = this.opts.pets.brief(owner.id);
    if (!pet) throw new HttpError(404, `${owner.display_name}还没有宠物`);
    const at = this.opts.now();
    const visitor = (this.db.prepare('SELECT display_name FROM users WHERE id = ?').get(visitorId) as { display_name: string }).display_name;
    const first = !this.visitedToday(visitorId, owner.id);
    // 喂之前先把他的宠物算到现在（饱食度按时间往下掉；远行、打工到点的结算掉）
    if (kind === 'feed') this.opts.pets.settle(owner.id);
    transaction(this.db, () => {
      if (kind === 'feed') this.opts.pets.feedOther(visitorId, owner.id, item ?? '');
      if (first) {
        addCrystals(this.db, visitorId, VISIT_REWARD, 'visit', `去${owner.display_name}家看${pet.name}`, null, at);
        addCrystals(this.db, owner.id, VISIT_REWARD, 'visit', `${visitor}来看${pet.name}`, null, at);
      }
      this.db
        .prepare('INSERT INTO pet_visits (visitor_id, owner_id, kind, item, rewarded, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(visitorId, owner.id, kind, kind === 'feed' ? item : null, first ? 1 : 0, at);
    });
    if (first) {
      this.opts.social.notify(owner.id, 'pet_visit', {
        from: this.opts.social.brief(visitorId),
        pet: pet.name,
        kind,
        item: kind === 'feed' ? (PET_FOOD.get(item ?? '') ?? null) : null,
        reward: VISIT_REWARD,
      });
      this.achievements?.check(visitorId, ['visit-10', 'rich']);
      // 隐藏成就「人见人爱」：宠物被好友串门（V0.7.0 以前是收到留言）
      this.achievements?.check(owner.id, ['rich', 'popular-pet']);
    }
    return { pet: pet.name, rewarded: first ? VISIT_REWARD : 0 };
  }
}

/** 能拿去串门喂的吃的：key → 名字。 */
const PET_FOOD = new Map<string, string>(PET_SHOP.filter((i) => i.kind === 'food').map((i) => [i.key, i.name]));
