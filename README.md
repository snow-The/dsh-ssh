# @snow-the/dsh-ssh

DSH 原生的 **agent 用 SSH 工具**：`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster` / `ssh_resolve`。

純宿主側外掛：沒有 GUI、沒有 client bundle、沒有任何瀏覽器程式碼，也**沒有任何 npm 執行期依賴**。
所有操作都走作業系統的 OpenSSH CLI（Windows 10+ 內建 `ssh` / `sftp`）——**不自己實作 SSH 協定**，
而是驅動一個已經懂協定的客戶端，把它的高階功能（`-J` 跳板、`-G` 設定傾印、`-L/-R/-D` 轉發、`sftp` 批次）交給 agent 用。

## 與 `@linxin666/dsh-ssh` 的差異

| | `@linxin666/dsh-ssh`（舊） | 本外掛 |
| --- | --- | --- |
| 形態 | GUI 外掛（有 client bundle，SSH 由 GUI 側子系統管） | 純宿主側工具外掛（`inject: ['tools']`） |
| 主機清單 | `~/.dsh/dsh-ssh.json`（該外掛自己的檔） | **`~/.dsh/ssh/hosts.json`（本外掛自己的檔）** |
| 舊清單 | — | 我們的檔案不存在時**一次性匯入**；舊檔只讀不寫、不刪、不改 |
| 認證 | 可存密碼並互動輸入 | 只用 OpenSSH CLI：`BatchMode=yes`，**不支援密碼**；用 `identityFile` 或 ssh-agent |
| 跳板 | 自己的 `proxyJump` 陣列（GUI 側解讀） | `proxyJump` 字串 → `ssh -J`（含 `user@host:port` 與多跳） |
| 給誰用 | 人（GUI 面板） | agent（工具呼叫） |

匯入只發生一次：`~/.dsh/ssh/hosts.json` 一旦存在，本外掛就只讀它。之後你改舊檔不會有任何效果
（舊檔留著也不會被動）。

## 七個工具

| 工具 | 參數 | 回傳 |
| --- | --- | --- |
| `ssh_list` | `query?`（模糊比對 alias/description/host/tags）、`tags?`（全部都要有）、`environment?` | `{count,total,source,imported,hosts:[{alias,host,port,user,tags,environment?,description?,identityFile?,proxyJump?}]}` |
| `ssh_exec` | `alias`(必填)、`command`(必填)、`timeoutMs?`（預設 60000）、`options?` | `{alias,exitCode,stdout,stderr}` |
| `ssh_upload` | `alias`、`localPath`、`remotePath`（皆必填）、`options?` | `{alias,direction,localPath,remotePath,ok,bytes?,exitCode?,stdout,stderr}` |
| `ssh_download` | `alias`、`remotePath`、`localPath`（皆必填）、`options?` | 同上（`direction: "download"`） |
| `ssh_tunnel` | `action`：`start` / `list` / `stop` / `stop-all`；`start` 需 `alias` + `direction?` + 對應的埠（見下表）、`options?`；`stop` 需 `tunnelId`（或 `alias`） | `{action,tunnelId,alias,direction,localAddress,target,localPort,remoteHost?,remotePort?,pid,startedAt,alive}` / `{action:"list",count,tunnels}` / `{action:"stop",stopped,tunnelIds,tunnels}` |
| `ssh_cluster` | `command`(必填)，**且** `aliases` / `environment` / `tags` 至少一個；`maxWorkers?`（預設 8）、`timeoutMs?`（預設 60000，每台） | `{command,matched,maxWorkers,timeoutMs,succeeded,failed,results:[{alias,host,exitCode,stdout,stderr,error?}]}` |
| `ssh_resolve` | `alias`(必填) | `ssh -G` 的解析結果，共 14 個鍵（見下） |

### 幾個一定要知道的語義

- **非零 exit code 不是工具錯誤。** `ssh_exec` 照實回傳 `exitCode`／`stdout`／`stderr`，agent 才看得到失敗輸出。
  逾時則回 `exitCode: 124`，並在本機 ssh 進程樹被殺掉後於 `stderr` 補一行說明。
- **`ssh_cluster` 的選擇器是 AND。** 給越多條件，集合只會越小。`tags` 要求「每一張標籤都在該主機上」。
  選擇器全部沒給、alias 不存在、或條件一臺都配不到 → **明確錯誤**，不會回空陣列。
- **alias 不存在一律拋錯並列出可用 alias**（`Available aliases: node-a, node-b, ...`），不會靜默回空。
- **`query` 模糊比對**的欄位是 alias / description / host / tags；多個以空白分隔的詞是 AND。
- **`ssh_upload` / `ssh_download` 失敗不拋錯**：回 `ok: false` 並附上 sftp 的 `stderr` 原文（還有 `exitCode`）。
  只有 spawn 失敗、逾時、被中止才拋錯——這樣「對面檔案不存在」不會變成一團沒有原文的例外。
- **Tunnel 活在這個外掛的進程裡**：啟動後 1.5 秒內死掉就回報 ssh 自己的 stderr，不會假裝成功。
  死掉的 tunnel 會留在 `list` 裡（`alive: false` + `note` 帶最後的 stderr），`stop` 才會清掉。

## 隧道：`-L` / `-R` / `-D`

`direction` 決定「哪一端在聽」：

| `direction` | argv | 誰在聽 | 導到哪 |
| --- | --- | --- | --- |
| `local`（預設） | `-L localPort:remoteHost:remotePort` | **本機** `127.0.0.1:localPort` | 由 SSH 主機看出去的 `remoteHost:remotePort` |
| `remote` | `-R remotePort:remoteHost:localPort` | **SSH 主機** 的 `remotePort` | 由本機看出去的 `remoteHost:localPort` |
| `dynamic` | `-D localPort` | **本機** `127.0.0.1:localPort`（SOCKS5） | 每個連線自己帶目的地 |

- `local` / `dynamic` 的 `localPort` 沒給 → 自動挑一個空閒埠。
- `remote` **必須**給 `localPort`（那是要被暴露出去的本機服務埠），猜錯會把錯的服務公開出去，所以不給預設。
- `remote` / `local` 的 `remoteHost` 預設 `127.0.0.1`。
- `dynamic` 給 `remoteHost` 或 `remotePort` → **明確錯誤**（SOCKS 由連線自己決定目的地，這兩個參數沒有意義；
  靜默忽略等於讓呼叫者以為生效了）。
- `action: list` 會回每個隧道的 `direction`、`localAddress`（實際在聽的位址）、`target`、`localPort`、
  `startedAt`、`alive`；死掉的還有 `endedAt` / `exitCode` / `note`。

## 主機清單格式

檔案：`~/.dsh/ssh/hosts.json`（Windows 即 `C:\Users\<你>\.dsh\ssh\hosts.json`）

```json
{
  "version": 1,
  "hosts": [
    {
      "alias": "node-a",
      "host": "203.0.113.10",
      "port": 22,
      "user": "root",
      "identityFile": "~/.ssh/id_ed25519",
      "tags": ["gas", "prod"],
      "environment": "gas",
      "description": "節點 A"
    },
    {
      "alias": "db-internal",
      "host": "10.0.0.9",
      "user": "deploy",
      "proxyJump": "ops@bastion:2200",
      "description": "只能從跳板進去的資料庫"
    },
    {
      "alias": "double-hop",
      "host": "10.9.9.9",
      "user": "root",
      "proxyJump": "jump1,jump2:2200"
    }
  ]
}
```

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `alias` | ✅ | 唯一，不可含空白或 `:` |
| `host` | ✅ | 主機名或 IP（IPv6 會自動加 `[]`） |
| `port` | — | 1–65535，預設 22 |
| `user` | ✅ | 登入使用者 |
| `identityFile` | — | 私鑰路徑，支援 `~` / `~/...`（`~user` 不支援，會明確報錯） |
| `proxyJump` | — | 跳板鏈，**字串**：`host`、`host:port`、`user@host:port`、`[ipv6]:port`，多跳用逗號分隔。組成 `ssh -J` |
| `tags` | — | 字串陣列 |
| `environment` | — | 字串（`ssh_list` / `ssh_cluster` 的精確篩選） |
| `description` | — | 字串（`query` 也會比對） |

`proxyJump` 的形狀是 `-J` 的語法，所以我們只擋掉 ssh 會誤讀的寫法（空 hop、空白、埠 0 或 70000、`user@` 沒有 host…），
其餘原樣交給 OpenSSH。舊版的 `proxyJump` 陣列會在匯入時用逗號接起來。

未知欄位（舊版的 `auth`、`createdAt`…）讀入時會被丟棄。JSON 壞掉、缺必填欄位、
alias 重複、port 不合理、`proxyJump` 壞掉 → **明確的錯誤訊息**（含檔案路徑與 `hosts[i]` 索引），不會偷偷當成空清單。

### 如何加主機

目前沒有「寫入清單」的工具（刻意如此：agent 不該自己改 SSH 目標）。直接編輯上面的 JSON 即可，
下一次工具呼叫就會生效——每個工具呼叫都重新讀檔，沒有快取。

驗證：

```jsonc
// 問 agent：
ssh_list({ query: "gas" })
ssh_resolve({ alias: "db-internal" })   // 問 OpenSSH：這個別名實際上會怎麼連？
```

### 從舊清單一次性匯入

若 `~/.dsh/ssh/hosts.json` 不存在、而 `~/.dsh/dsh-ssh.json` 存在：

1. 讀舊檔（`{version, hosts}`），把 `identityFile`（或 `auth.kind === "key"` 時的 `auth.keyPath`）對應過來；
   `auth` 丟棄，`proxyJump` 陣列**用逗號接成 `-J` 字串**（空陣列 = 沒有跳板）；
2. 用我們的格式寫出 `~/.dsh/ssh/hosts.json`；
3. `console.log` 一行：`[snow-ssh] 從舊清單匯入了 N 筆主機：<舊檔> -> <新檔>（舊檔保留未動）`；
4. 舊檔**完全不動**。

密碼認證的主機會被匯入，但 `BatchMode=yes` 無法互動輸入密碼，所以匯入時會另外 `console.warn` 提醒
（列出 alias）。請改成 `identityFile` 或讓 ssh-agent 持有金鑰。
舊 `proxyJump` 若是我們讀不懂的形狀（例如不是字串的物件），會**印出 warning 並忽略那一筆欄位**，
不會讓整次匯入失敗——因為那個欄位你無法從 DSH 裡面修。

## 用上 OpenSSH 的高階功能

### `ssh_resolve`：不要相信 hosts.json，去問 ssh

`ssh_resolve` 執行的是：

```
ssh -G -o HostName=<host> -o User=<user> -o Port=<port> [-o IdentityFile=<key>] [-o ProxyJump=<jump>] <alias>
```

`ssh -G` 只解析設定、**不連線**。因為我們把自己的主機記錄先疊上去，**不在 `~/.ssh/config` 裡的別名也能正確解析**；
同時 `alias` 仍是最後的 destination 參數，所以 `~/.ssh/config` 裡 `Host <alias>` 區塊的東西才是真正的答案來源：

- `hostname` / `user` / `port` — 實際會連的位址
- `proxyjump` / `proxycommand` — 實際會走的跳板（`proxyjump` 會是正規化後的 `bastion@[10.0.0.5]:2200`）
- `identityfile` — **陣列**，ssh 會依序嘗試
- `controlmaster` / `forwardagent` — 多工是否開啟、agent 是否轉發
- `localforward` / `remoteforward` / `dynamicforward` — 設定檔裡默默生效的轉發（**陣列**）
- `serveraliveinterval` / `connecttimeout` — keepalive 與連線逾時

失敗（ssh 不在 PATH、非 0 結束、輸出空的、沒有 `hostname`/`port`）一律**拋錯並附上 ssh 的 stderr 原文**，
**不會回一個空物件**——空物件會被誤讀成「這個別名沒有特殊設定」，那是最糟的答案。

會疊上去的只有這五個 `-o`，**不會**加 `BatchMode` / `ConnectTimeout`：那些不是「這個別名會怎麼連」的一部分，
加了反而會蓋掉你要看的 `connecttimeout` / `serveraliveinterval`。

### `proxyJump` → `ssh -J`

`hosts.json` 的 `proxyJump` 直接變成 `-J`，多跳如 `jump1,jump2:2200` 交給 OpenSSH 自己串。
這是本外掛對「跳板」的正式支援；README 不再叫你自己去改 `~/.ssh/config`。

## 傳輸：為什麼是 `sftp -b -` 而不是 scp

`scp` 自 OpenSSH 9.0 起預設走 SFTP 協定，**舊的 scp/rcp 協定已棄用**（要用還得另外開 `-O`）。
本外掛直接呼叫 `sftp`，把批次指令寫到**子進程的 stdin**：

```
sftp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i <key> -P <port> -b - <user>@<host>
```

stdin 內容只有一行：

```
put "<本機路徑>" "<遠端路徑>"        # upload
get "<遠端路徑>" "<本機路徑>"        # download
```

- **不寫暫存檔**：`-b -` 就是從 stdin 讀批次，所以沒有任何 `*.tmp`、沒有競態、沒有忘記清掉的檔。
- **路徑用 `"..."` 包起來**：這樣含空白、`$`、`;`、`'` 的路徑都是一個參數。**反斜線原樣傳遞**（不轉義、不加倍）。
- **路徑含 `"` 直接拒絕**：這是實測結果，不是推測——`sftp` 的批次解析器只會把引號剝掉，
  **不認任何轉義字元**（`get "/etc/a\"b"` → `Unterminated quoted argument`；`""` → 變成空字串）。
  含雙引號的路徑根本無法寫成批次指令，所以寧可明確報錯，也不要送出一個看起來對、實際錯的指令。
- **路徑含換行/控制字元直接拒絕**：sftp 的批次語法是一行一個指令，換行會變成**第二個指令**，
  而 sftp 有 `!cmd`（跑本機指令）——這是真的注入面，所以寧可報錯。
- `-b` 讓 sftp 一失敗就帶非 0 結束碼退出，但外掛不把它當例外丟掉：回 `{ok:false, stderr}`。

## `options`：直通的 `-o`（以及被拒的三個鍵）

`ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` 都吃 `options: ["Key=Value", …]`，每個元素變成一個 `-o`。

**順序很重要**：OpenSSH 對同一個 keyword 取**第一個**看到的值，所以呼叫者的 `-o` 放在我們的安全選項**之前**
（放後面會變成「看起來被接受了、其實沒生效」）。這也意味著呼叫者可以覆寫 `BatchMode` 之類的預設值——那是刻意的。

**被拒絕**（明確錯誤、訊息含鍵名與理由，不是靜默忽略）：

| 鍵 | 為什麼拒絕 |
| --- | --- |
| `ProxyCommand` | 它會在**本機**執行任意程式，而不是開一條 SSH 通道（跳板請用 `proxyJump`） |
| `LocalCommand` | 它在連線建立時於**本機**執行任意程式 |
| `PermitLocalCommand` | 它讓遠端主機的設定能啟動 `LocalCommand`，等於繞道在本機執行程式 |

另外會擋掉：不是 `Key=Value` 形狀、key 不是單一 ssh keyword、值裡有換行或控制字元（換行等於多一行設定，
可以夾帶 `ProxyCommand`）。`Include` 只能寫在 config 檔裡，`-o Include=…` 不是有效用法。

## 沒有 ControlMaster（而且不假裝有）

**連線多工沒有實作，也沒有模擬。** Windows 版 OpenSSH（`OpenSSH_for_Windows_9.5p2`）不支援：

```
$ ssh -o ControlMaster=yes -o ControlPersist=10m node-b true
getsockname failed: Not a socket
```

不會產生任何 socket，`-M`/`-S` 也無從接上。所以：

- 每個 `ssh_exec` / `sftp` / tunnel 都是**自己的連線**；別期待第二次呼叫比較快。
- 想要「少一點握手」請用**常駐 tunnel**（`ssh_tunnel action=start`，一條連線撐著）或 `proxyJump`/`-J` 把多跳收斂成一次連線。
- `ssh_resolve` 會照實回報 `controlmaster`，所以在這台機器上你通常會看到 `false`，在 Linux 上才可能是 `auto`/`yes`。

## 認證與安全邊界

- 每次 `ssh`/`sftp` 都帶 `-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=N`；
  有 `identityFile` 就加 `-i`，有 `proxyJump` 就加 `-J`，並顯式帶 `-p`（sftp 是 `-P`）。
- `BatchMode=yes` 讓「需要密碼」立刻失敗而不是卡住等輸入。**沒有** `sshpass`、**不**儲存密碼。
- 通行片語（passphrase）保護的金鑰需要 ssh-agent（Windows 的 `ssh-agent` 服務）已載入。
- `ssh_exec` 的 `command` 是**單一 argv 元素**，由遠端使用者的 shell 解析——這是「在對面跑一行 shell」的功能本身。
  本機完全不經 shell、不做字串插值；所有路徑、選項、主機都是 argv 元素。
- `ssh_upload` / `ssh_download` 的路徑不會經過任何 shell：它們是 sftp 批次語法的資料。
- 本機 local port forward 預設綁在 localhost（ssh `-L` 的預設）。
- `ssh_resolve` 只跑 `ssh -G`，不連線、不讀私鑰內容、不改任何設定檔。

## DSH API 相容性（給改這個外掛的人）

本外掛用 `import { defineTool } from '@deepseek-ai/dsh-tools'`。在目前主機的 `0.2.2-rc.1`
（peer 要求 `>=0.2.1-rc.5`）上，`defineTool` 的兩種 schema 不是同一種東西：

- `parameters` 是 **property map**（每個屬性 `{ type, required?, description?, items?, enum? }`），
  由 `defineTool` 編譯成 `{type:"object", properties, required}`——直接塞 raw JSON Schema 會載入失敗
  （`parameters.type must be a value schema object`）。
- `output.schema` 是 **raw JSON Schema**，而且**每個 `type: "object"` 節點都必須明確寫
  `additionalProperties`（`true` 或 `false`）**，否則整個外掛載入失敗。root 不能寫 `required`。

`test/contract.test.mjs` 會把七個 output schema 從原始碼抽出來、當資料求值，遞迴檢查這件事，
所以改 schema 時忘記 `additionalProperties` 會直接測試失敗。

## 開發與測試

```bash
npm test          # = node --test test/
node --test test/ # 同上（靠 test/index.js 這個 shim）
```

測試**不需要網路、不需要任何 SSH 伺服器**：只測純函式（清單解析／驗證／`~` 展開／argv 組裝（含 `-J`、`-o`、
`-L/-R/-D`）／sftp 批次字串／`ssh -G` 輸出解析／alias 解析／篩選／併發池）與靜態契約
（manifest、patch 檔、七個工具、output schema、README 的關鍵詞）。
`ssh_resolve` 的 `ssh -G` 是用**注入的 runner** 測的，所以一個測試都不會 spawn `ssh`。

> `test/index.js` 是 Node 26 的相容 shim：`node --test <目錄>` 已不再展開目錄，而是把 `test/`
> 當模組解析，因此需要 `test/index.js`。副作用：直接跑 `node --test`（不帶路徑）會同時發現
> shim 與各測試檔，等於跑兩次。用 `npm test` 就沒這問題。

## 已知限制／風險

- **只能在有 OpenSSH CLI 的機器上跑**（Windows 10+ 內建；找不到 `ssh`/`sftp` 時會回明確錯誤）。
- **沒有連線多工**（見上一節，平台不支援）；每次呼叫都是一條新連線。
- **沒有 keepalive 預設值**：長時間 tunnel 若中間設備斷線，ssh 可能不會自己重連。
  請用 `ssh_tunnel` 的 `options: ["ServerAliveInterval=15"]`（或 `ssh_exec` 的 `options`）明確開啟。
- **`ssh_exec` 沒有 stdin**：`stdio` 的 stdin 是關閉的（`BatchMode` 的同一個理由：工具呼叫不能卡在互動輸入）。
  要傳資料請用 `ssh_upload` 或把資料放在遠端。
- **`ssh_cluster` 是同一條命令廣播**，不是平行腳本框架；每台的結果各自獨立，單台失敗不會中止其他台。
  它不吃 `options`（要嘛改 hosts.json，要嘛用 `ssh_exec` 逐台跑）。
- **Tunnel 只存在於本外掛進程**：DSH 重啟後 tunnel 消失是預期行為；`stop` 之後 `ssh` 子進程會被殺掉。
- **`remote` tunnel 的可用性取決於 sshd**：`GatewayPorts`/防火牆可能讓遠端只綁在 127.0.0.1，或直接拒絕。
  連不上時先看 `ExitOnForwardFailure` 讓 ssh 吐出來的 stderr（就在錯誤訊息裡）。
- **輸出上限** 每個串流 4 MiB，超過會截斷並附註記；遠端輸出非 UTF-8 會以 UTF-8 解碼（可能出現替換字元）。
- 本外掛不碰 profile、不自動安裝、不寫任何 profile 設定檔。
