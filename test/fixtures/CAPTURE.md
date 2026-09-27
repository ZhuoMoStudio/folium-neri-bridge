# 登录样本怎么抓、怎么脱敏

`test/10-selfcheck.mjs` 用这三个 JSON 离线重放「扫码成功后凭据从哪来」的三条路
（`lib/bili-login.cjs` 里的 `resolveLoginCookies`）。

**现在的三个文件是合成样本，不是抓包。** 它们的形状照着实测的响应写，但值全是
`FAKE_…_FOR_TESTS` 占位符 —— 目的只是把三条路的顺序与优先级钉住。
真机扫一次码能拿到的信息比合成样本多（比如 poll 那一跳到底会不会顺带下 `bili_jct`），
所以这里留了一个位置给真样本。

## 为什么要脱敏，怎么脱

`SESSDATA` 等价于账号本身：拿它可以以你的身份调接口。**不要把它提交上去。** 脱敏后的样本
仍然有用 —— 它证明的是「凭据由哪一跳下发」这个流程，不是凭据的值。

替换规则（测试里有一条断言按这个规则检查，见 `test/10-selfcheck.mjs` 第 4 节）：

- 每个密钥值换成以 `FAKE` / `TEST` / `REDACTED` / `PLACEHOLDER` / `EXAMPLE` 开头、
  全大写字母数字下划线的短占位符，例如 `SESSDATA=FAKE_SESSDATA_FOR_TESTS`；
- 占位符长度别超过 24 字符，也别留着 `%2C`（真实的 SESSDATA 就是
  `<base64>%2C<时间戳>%2C<sha256>`，带 `%2C` 的一律会被断言判为「像真的」）；
- `buvid3` / `buvid4` 这类设备指纹不是凭据，但也一并换掉，省得以后有人以为它们没关系；
- 文件里不要留自己的 uid：`DedeUserID` 换成 `4242424242` 这种明显的假号。

## 抓的步骤

要抓的是**扫码成功那一刻的两个响应**。准备：浏览器（或 Folia 的开发模式窗口）打开
`https://passport.bilibili.com/login`，DevTools → Network，勾上 `Preserve log`，
过滤 `passport-login/web/qrcode`。

1. 页面加载时会有一个 `generate` 请求，记下响应里的 `data.qrcode_key`。
2. 手机扫码并在 App 里确认。轮询请求 `qrcode/poll?qrcode_key=…` 会从 86101 →
   86038/86090 → 0 变化。**注意那个 `code` 变成 `0` 的响应**：
   - 记录它的 **Response Headers 里的全部 `Set-Cookie`**（DevTools 里可能折叠成一行，
     点开 Raw 看，多个 `Set-Cookie` 是分行的）；
   - 记录它的 **响应体 JSON**，重点是 `data.url`。
3. 如果响应体里的 `data.url` 指向 `passport.biligame.com/crossDomain…`（票据链接），
   说明是 2026-08 之后的新形状：**再找那条由它触发的后续请求**（同一个窗口会自动跳过去），
   记录那一跳 Response Headers 里的 `Set-Cookie`。没有这一条，第三个 `routes` 就少了证据。
4. 把三段内容按下面的形状整理成 `login-poll-local.json`，放到**本目录**下：

```json
{
    "note": "抓包日期与形状说明",
    "kind": "crossdomain",
    "capturedAt": "2026-09-27",
    "pollSetCookies": ["<poll 响应的第 1 条 Set-Cookie>", "…"],
    "ticketUrl": "<响应体里的 data.url>",
    "ticketSetCookies": ["<票据那一跳的第 1 条 Set-Cookie>", "…"],
    "expect": { "followTicket": true, "hasSession": true, "routes": ["ticket-set-cookie"] },
    "expectFields": ["SESSDATA", "bili_jct", "DedeUserID"]
}
```

**脱敏之后**再保存。

5. 跑测试：

```bash
npm test                      # 离线四项
npm run test:selfcheck        # 只跑这一套
```

`test/10-selfcheck.mjs` 发现本目录下有 `login-poll-local.json` 就会自动把它一起验了 ——
先验脱敏（不通过直接 FAIL），再把它丢进同一条流程里重放三条路。真样本与合成样本的
差别只在于它证明了「上游现在确实是这么下发的」。

## 不想提交真样本？

把文件命名成 `login-poll-local.json` 并**不要 commit**（`.gitignore` 已按 `-local`
忽略 `test/fixtures/*-local.json`）。测试在本地会跑它，在 CI 上会跳过这一节。
