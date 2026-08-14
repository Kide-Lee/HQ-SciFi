/**
 * 本应用（黄芪饮片）用户协议同意状态的持久化键。
 * 首启协议门（FirstRunAgreement）与登录页共用：任一处同意后写入协议版本号，
 * 与协议文件版本（doc/用户协议.md 首部「版本：vX.Y」）比对，协议更新后强制重新阅读并同意。
 * 荒启平台协议（登录页单独勾选）不在此键内。
 */
export const AGREEMENT_KEY = 'hqsf-agreement-version'
