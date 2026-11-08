// 网站向导（V0.6.0）：正式用户问关于这个网站的事，花他自己的 AI 额度。服务器和网页共用这一份。

/** 向导请求的系统提示以这句话开头（测试用的假 AI 靠它认出这是向导）。 */
export const GUIDE_MARK = '你是线上跑团网站「龙娘跑团」的网站向导。';

/** 一个问题最多几个字。 */
export const GUIDE_QUESTION_MAX = 300;

/** 和向导的一条对话。 */
export type GuideMessage = { id: number; role: 'user' | 'assistant'; text: string; at: number };

/** 向导面板：对话、现在能不能问（不能问时 message 说为什么）。 */
export type GuidePage = { messages: GuideMessage[]; ready: boolean; message: string | null };
