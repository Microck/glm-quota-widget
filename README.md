<h1 align="">glm-quota-widget</h1>

<p align="">
  tiny bridge + scriptable widget for Z.ai GLM coding plan quotas.
</p>

show your GLM 5-hour token window, weekly token window, and MCP usage from a home-screen widget without exposing your Z.ai API key to the phone.

---

## quick start

run the bridge on the machine that should hold the Z.ai API key:

```bash
cd glm-quota-widget

GLM_QUOTA_API_KEY="your-zai-api-key" \
GLM_QUOTA_WIDGET_TOKEN="$(openssl rand -hex 18)" \
GLM_QUOTA_WIDGET_HOST="127.0.0.1" \
node server.mjs
```

or create a local env file:

```bash
cp .env.example .env
$EDITOR .env
```

if your phone reaches the machine over tailscale, bind the bridge to that tailscale address:

```bash
GLM_QUOTA_API_KEY="your-zai-api-key" \
GLM_QUOTA_WIDGET_TOKEN="<your-widget-token>" \
GLM_QUOTA_WIDGET_HOST="100.x.y.z" \
node server.mjs
```

open:

```text
http://100.x.y.z:8766/quota?token=<your-widget-token>
```

---

## configuration

| variable | default | purpose |
| --- | --- | --- |
| `GLM_QUOTA_API_KEY` | required | Z.ai or Zhipu API key for one account. |
| `GLM_QUOTA_API_KEYS` | empty | Comma-separated API keys when you want to merge multiple accounts. |
| `GLM_QUOTA_ACCOUNT_LABELS` | `GLM`, `GLM 2`, ... | Optional comma-separated labels matching `GLM_QUOTA_API_KEYS`. |
| `GLM_QUOTA_API_BASE_URL` | `https://api.z.ai` | Use `https://open.bigmodel.cn` for the China endpoint. |
| `GLM_QUOTA_AUTH_SCHEME` | `bearer` | Use `raw` only if your token source expects `Authorization: <token>`. |
| `GLM_QUOTA_WIDGET_TOKEN` | empty | Shared secret required by `/quota?token=...`; empty disables widget auth. |
| `GLM_QUOTA_WIDGET_HOST` | `127.0.0.1` | Host address the bridge binds to. |
| `GLM_QUOTA_WIDGET_PORT` | `8766` | Bridge port. |

---

## start at boot

install the systemd service:

```bash
cp .env.example .env
perl -0pi -e "s/replace-with-output-of-openssl-rand-hex-18/$(openssl rand -hex 18)/" .env
$EDITOR .env
./install-startup-service.sh
```

the installer writes `glm-quota-widget.service` to `/etc/systemd/system`, starts it immediately, and enables it for `multi-user.target`.

the generated service:

- reads bridge configuration from the ignored local `.env`
- starts after network ordering
- includes Tailscale ordering for hosts that bind to a Tailscale address
- restarts every 10 seconds if the bridge exits while the network finishes starting

check it later with:

```bash
systemctl status glm-quota-widget.service --no-pager
```

---

## ios widget

install Scriptable, paste `scriptable-widget.js`, and set:

```js
const QUOTA_URL = "http://100.x.y.z:8766/quota?token=<your-widget-token>";
```

then add a Scriptable widget to the home screen and select the script.

the script asks ios to refresh the widget every 5 minutes. ios may still delay home-screen widget refreshes.

---

## what it reads

the bridge calls the Z.ai monitoring endpoint:

```text
GET /api/monitor/usage/quota/limit
```

the widget shows:

- 5-hour token quota
- weekly token quota when the API returns it
- monthly MCP usage when the API returns it
- ready/blocked account counts and reset times

the Z.ai API key is never returned by the bridge. API responses are normalized before reaching the widget.

the quota endpoint is not part of the public model API surface and may change without notice.
