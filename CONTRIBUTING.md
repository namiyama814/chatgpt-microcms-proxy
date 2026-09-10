# Contributing

Issue や pull request を歓迎します。変更前に既存 Issue を確認し、認証・secret・MCP transport に影響する変更は目的と互換性を明記してください。

## Before opening a pull request

```sh
npm install
npm run check
```

- `.dev.vars`、`.env`、access token、API key、OAuth client secret をコミットしないでください。
- MCP request / response を JSON 化・バッファリングせず、streaming と `MCP-Session-Id` を保つことを確認してください。
- 新しい外部接続先やユーザー指定 URL を追加しないでください。proxy は固定 microCMS endpoint のみを許可します。
- 認可・cookie・OAuth callback を変更する場合は、失敗経路と security regression test を追加してください。

脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) に従って報告してください。
