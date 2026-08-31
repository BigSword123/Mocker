export interface OnboardingResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function certDownloadResponse(certPem: string): OnboardingResponse {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="mocker-ca.pem"',
    },
    body: certPem,
  };
}

export function guidePageResponse(proxyHost: string, proxyPort: number): OnboardingResponse {
  const url = `http://${proxyHost}:${proxyPort}`;
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mocker 设备接入</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#222;line-height:1.6}
code{background:#f0f0f4;padding:2px 6px;border-radius:4px}
h1{font-size:22px} h2{font-size:16px;margin-top:24px}
a.btn{display:inline-block;background:#3b6ef6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
</style></head>
<body>
<h1>Mocker 设备接入</h1>
<p>代理已生效：本机代理设置为 <code>${proxyHost}:${proxyPort}</code></p>
<p><a class="btn" href="${url}/ca.pem">下载 Mocker 根证书</a></p>
<h2>iOS</h2>
<ol><li>点击上方按钮下载描述文件</li>
<li>设置 → 已下载描述文件 → 安装</li>
<li>设置 → 通用 → 关于本机 → 证书信任设置 → 开启完全信任</li></ol>
<h2>Android</h2>
<ol><li>点击上方按钮下载证书（.pem）</li>
<li>设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书</li>
<li>注意：Android 7+ 仅 debuggable 应用或配置了信任用户 CA 的应用走用户证书；做了证书固定（SSL Pinning）的应用无法抓包</li></ol>
</body></html>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}
