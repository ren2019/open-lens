# 部署在自有 aliyun 服务器，renzhhen.me 域名 + Caddy 自动 HTTPS + 单 token 鉴权

服务器定在用户自有 aliyun（公网可达，非 Mac 局域网方案）。iOS Safari 的相机 API（getUserMedia）仅在 secure context 下可用，IP 直连 + 自签证书在 iOS 上不可用，因此公网部署必须有域名 + 有效证书：使用已有域名 renzhen.me 的子域 + Caddy 自动 HTTPS（证书自动签发续期）。

公网暴露的扫描件与 MCP 接口用单 token 鉴权：前端首次输入存 localStorage，server 校验一个环境变量，MCP server 共用同一 token。不做用户系统——单用户自用。

## Consequences

- server 不得写死 localhost；HTTPS 由 Caddy 终结，应用层只听 HTTP。
- token 泄漏的后果是扫描件可见，可接受；换 token = 改环境变量重启。
