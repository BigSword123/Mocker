# Mocker

Charles 式本地抓包与 Mock 工具（开发者自用）。

## 功能（Phase 1）

- HTTP/HTTPS 抓包（HTTPS 白名单 MITM / 全量解密可切换）
- 实时流量列表与请求/响应详情
- 静态响应 Mock 规则（URL 精确/通配/正则 + method + query + 头 + 请求体包含）
- 根证书管理与手机扫码接入（Android / iOS）
- 系统代理一键开关（macOS / Windows）

## 开发

- `npm install`
- `npm run dev` 启动开发模式
- `npm test` 单元/集成测试
- `npm run test:e2e` E2E 冒烟
- `npm run typecheck` 类型检查

## 手机接入

1. 手机与电脑同网段，设置系统代理为 `电脑IP:8888`
2. 手机浏览器访问 `http://电脑IP:8888` 按指引安装证书
3. HTTPS 抓包：在「设置」中把目标域名加入白名单

## 已知限制

见「设备接入」页说明：Android 7+ 用户证书、SSL Pinning、iOS 私有中继、HTTP/3。

## 设计文档

`docs/superpowers/specs/2026-09-01-mocker-design.md`
