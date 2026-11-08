// 公告的固定模板（V0.6.0）：管理页「公告」里点一下就填好标题、内容、发给谁，【】里的换成实际的内容再发。
// 「全服发额度」「全服发龙晶」会真的发：发公告的同时给收到公告的正式账号每人发一份（要同时有「发公告」「发放额度」权限）。
// 内容里的 {数额} 发出去时会换成实际发的数额。

export type AnnounceAudience = 'all' | 'guest' | 'user' | 'admin' | 'users';
export type AnnounceGrantKind = 'credit' | 'crystals';

export type AnnounceTemplate = {
  key: string;
  name: string;
  title: string;
  body: string;
  audience: AnnounceAudience;
  grant?: AnnounceGrantKind;
};

export const AMOUNT_TOKEN = '{数额}';

export const ANNOUNCE_TEMPLATES: AnnounceTemplate[] = [
  {
    key: 'warn',
    name: '警告某人',
    audience: 'users',
    title: '警告',
    body: '【对方的名字】：\n你在【时间、地点】【做了什么】，违反了使用规则里的「【哪一条】」。这是警告，再犯会封号。\n有疑问可以点页面最下面的「反馈问题」联系管理员。',
  },
  {
    key: 'credit',
    name: '全服发额度',
    audience: 'user',
    grant: 'credit',
    title: '全服发放 AI 额度',
    body: `【发放的原因】，每个正式账号都发了 ${AMOUNT_TOKEN} AI 额度，已经到账。`,
  },
  {
    key: 'crystals',
    name: '全服发龙晶',
    audience: 'user',
    grant: 'crystals',
    title: '全服发放龙晶',
    body: `【发放的原因】，每个正式账号都发了 ${AMOUNT_TOKEN}，已经到账，在「商城」的「龙晶记录」里看得到。`,
  },
  {
    key: 'maintenance',
    name: '停机维护',
    audience: 'all',
    title: '停机维护通知',
    body: '【开始时间】到【结束时间】停机维护，这段时间网站打不开，维护完就恢复。\n【维护的内容】',
  },
  {
    key: 'release',
    name: '新版本上线',
    audience: 'all',
    title: '【版本号】上线了',
    body: '这次更新了：\n- 【新功能】\n- 【修好的问题】\n遇到问题请点页面最下面的「反馈问题」告诉我们。',
  },
  {
    key: 'event',
    name: '活动开始',
    audience: 'all',
    title: '【活动名】开始了',
    body: '【开始时间】到【结束时间】：\n- 【分区】分区的剧本玩完，龙晶翻倍\n- 商城里有限时的【商品】\n- 活动期间玩完，得到称号「【称号】」',
  },
  {
    key: 'rules',
    name: '规则调整',
    audience: 'all',
    title: '使用规则调整',
    body: '从【日期】起，使用规则有这些调整：\n- 【调整的内容】\n完整的规则在页面最下面的「使用规则」里。',
  },
];

/** 全服发龙晶一次最多每人发多少。 */
export const ANNOUNCE_CRYSTALS_MAX = 10_000;
