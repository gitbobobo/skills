---
name: uiv
description: 把截图、录屏等图片和视频上传到 UIV，拿到公开链接和可直接粘贴的 Markdown。用于在 PR 描述、评论、issue 中展示端到端验证成果。
---

# UIV：上传图片和视频，拿到公开链接

UIV 是一个自托管的图片/视频服务。上传后返回公开链接，任何人（包括 GitHub）都能直接访问。

## 前提

需要两个环境变量：

- `UIV_URL`：UIV 的**公网**地址，例如 `https://uiv.example.com` 或 `http://1.2.3.4:7000`。必须是 GitHub 能访问到的地址，局域网或 Tailscale 地址生成的链接在 PR 里会显示为裂图。
- `UIV_TOKEN`：上传用的 token。

缺少任意一个时，停下来请用户提供，不要猜测。

## 上传

一次上传一个文件，字段名固定为 `file`：

```bash
curl -fsS -H "Authorization: Bearer $UIV_TOKEN" -F "file=@screenshot.png" "$UIV_URL/api/files"
```

Windows PowerShell 里 `curl` 是别名，要写 `curl.exe`：

```powershell
curl.exe -fsS -H "Authorization: Bearer $env:UIV_TOKEN" -F "file=@screenshot.png" "$env:UIV_URL/api/files"
```

成功返回 HTTP 201 和 JSON：

```json
{
  "id": "k3J9xQ2mPa",
  "url": "https://uiv.example.com/f/k3J9xQ2mPa.png",
  "markdown": "![screenshot.png](https://uiv.example.com/f/k3J9xQ2mPa.png)",
  "name": "screenshot.png",
  "size": 48213,
  "type": "image/png",
  "created_at": "2026-10-03T15:44:18.486Z"
}
```

把 `markdown` 字段原样贴进 PR 描述或评论即可。图片会生成 `![..](..)` 形式，直接显示；视频会生成 `[..](..)` 形式，显示为链接。

## 选择格式

- 截图：PNG，或 WebP（体积更小）。
- 演示操作流程：优先录成 GIF 或动画 WebP。GitHub 只会内嵌播放上传到 GitHub 自己的视频，外链 MP4 只显示为链接，点开后才能播放。
- 较长的演示：MP4（H.264）或 WebM，贴链接即可。
- 只接受图片和视频（PNG、JPEG、GIF、WebP、AVIF、HEIC、BMP、SVG、MP4、WebM、MOV、AVI），按文件内容判断，和扩展名无关。默认单文件上限 200MB。

## 注意

- 链接是公开的，没有 token 也能访问。不要上传含密钥、个人信息或内部数据的截图；必要时先裁剪或打码。
- 链接永久有效，除非有人在 UIV 管理后台手动删除。
- 同一个文件上传两次会得到两个不同链接，重新上传前先确认确实需要。

## 错误处理

失败时返回 JSON `{"error": "..."}`：

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 401 | token 缺失或错误 | 检查 `UIV_TOKEN`，不要反复重试 |
| 413 | 文件超过大小上限 | 压缩、裁剪、降低分辨率或缩短视频 |
| 415 | 不是允许的图片/视频类型 | 转换成上面列出的格式 |
| 400 | 请求格式不对 | 确认用的是 `-F "file=@路径"` |

检查服务是否可用：`curl -fsS "$UIV_URL/api/health"`，返回 `{"version":"..."}`。
