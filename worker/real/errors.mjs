/**
 * errors.mjs — 真实 worker 骨架共用的错误类型。
 *
 * 设计原则：失败必须如实回写到面板请求上，绝不假成功。
 * - ConfigMissing    ：需要的环境变量没配置（missing 里列出变量名）。
 * - SourceUnavailable：聚合站当前不可用（登录墙 / 验证码 / 403 / 网络错误）。
 * - GuangyaError     ：光鸭接口返回业务错误（msg 为服务端原文或本地归类）。
 * - ShareInvalid     ：分享已失效或提取码错误（GuangyaError 的子类）。
 * - NotImplemented   ：骨架里明确留空、需要部署者补实现的方法。
 */

export class ConfigMissing extends Error {
  constructor(...names) {
    const flat = names.flat();
    super(`缺少配置：${flat.join('、')}`);
    this.name = 'ConfigMissing';
    this.missing = flat;
  }
}

export class SourceUnavailable extends Error {
  constructor(site, reason) {
    super(`${site}不可用：${reason}`);
    this.name = 'SourceUnavailable';
    this.site = site;
    this.reason = reason;
  }
}

export class GuangyaError extends Error {
  constructor(message, apiCode) {
    super(message);
    this.name = 'GuangyaError';
    this.apiCode = apiCode;
  }
}

export class ShareInvalid extends GuangyaError {
  constructor(message, apiCode) {
    super(message, apiCode);
    this.name = 'ShareInvalid';
  }
}

export class NotImplemented extends Error {
  constructor(what) {
    super(`未实现：${what}`);
    this.name = 'NotImplemented';
  }
}
