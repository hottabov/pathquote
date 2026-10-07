# Act! API certificate — automated renewal

`https://actapi.pathfindercut.com` is how PathQuote and n8n reach the Act! Web
API. The Act! server terminates TLS itself, so it needs a certificate valid for
that hostname.

The server sits on the office LAN with no inbound access except the one NAT
rule that carries API traffic. Nobody outside the office can renew anything on
it by hand. Left manual, this integration breaks the first time the person who
knows about it is away — which is why it is automated rather than written on a
calendar.

## The arrangement

| Binding | Certificate | Owner | Purpose |
|---|---|---|---|
| `actapi.pathfindercut.com:443` (SNI) | `CN=actapi.pathfindercut.com` | us | the integration |
| `0.0.0.0:443` (catch-all) | `CN=*.pathfindercut.com` | the IT provider | Act! sync and everything else |

A hostname-specific SNI binding wins over the catch-all, so the two coexist and
neither depends on the other. If the provider's wildcard lapses, the
integration does not notice. **Never touch the `0.0.0.0:443` binding** — Act!
sync for every manager's laptop runs through it.

## How renewal flows

```
certbot on the VPS          renews every 60 days, DNS-01 via Cloudflare
        |
        v
publish-pfx.sh              deploy hook, rebuilds /var/www/actapi-cert/actapi.pfx
        |
        v
nginx on the VPS            serves it to one IP, behind a bearer token
        |
        v  outbound HTTPS, weekly
Sync-ActApiCertificate.ps1  on the Act! server: fetch, compare, rebind if changed
```

Every connection is outbound from the Act! server. Nothing listens, nothing is
installed, no firewall rule is added.

## Installing

### On the VPS

```bash
echo "<pfx password>" | sudo tee /root/.secrets/pfxpass >/dev/null
sudo chmod 600 /root/.secrets/pfxpass

sudo install -m 755 publish-pfx.sh \
  /etc/letsencrypt/renewal-hooks/deploy/actapi-pfx.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/actapi-pfx.sh     # run once now
```

Generate a token and put it where nginx can read it but git cannot:

```bash
openssl rand -hex 32
sudo tee /etc/nginx/conf.d/actapi-token.conf >/dev/null <<'EOF'
map $http_authorization $actapi_token_ok {
    "Bearer <paste the token>"  1;
    default                     0;
}
EOF
```

Add `nginx-actapi-cert.conf` into the server block that already answers for the
VPS, then `sudo nginx -t && sudo systemctl reload nginx`.

Check it refuses strangers and accepts the office:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<vps-host>/actapi-cert/actapi.pfx
# 403 from anywhere other than 180.181.193.49, and 403 without the token
```

### On the Act! server

Create `C:\Scripts\act-cert`, copy `Sync-ActApiCertificate.ps1` into it, and
write `config.json` beside it:

```json
{
  "Url": "https://<vps-host>/actapi-cert/actapi.pfx",
  "Token": "<the token>",
  "PfxPassword": "<the pfx password>",
  "HostName": "actapi.pathfindercut.com",
  "SiteName": "Default Web Site"
}
```

Lock the directory down — it holds two secrets:

```powershell
icacls C:\Scripts\act-cert /inheritance:r `
  /grant "SYSTEM:(OI)(CI)F" /grant "Administrators:(OI)(CI)F"
```

Dry run first, then schedule:

```powershell
powershell -File C:\Scripts\act-cert\Sync-ActApiCertificate.ps1 -WhatIf

$d = "C:\Scripts\act-cert"
$a = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File $d\Sync-ActApiCertificate.ps1"
$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
$p = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "Act API certificate sync" -Action $a -Trigger $t -Principal $p
```

## What it does on each run

Fetches the published PFX, reads its thumbprint **without importing it**, and
compares against what is bound. Unchanged means it stops there and the store is
never touched. Changed means import, rebind the SNI binding, and delete the
superseded certificate — but only if no other binding still uses it.

It refuses to install a certificate that has already expired, which turns a
broken publisher into a loud failure rather than an outage.

## When something is wrong

Failures go to the Windows Application event log under source `ActApiCertSync`,
alongside `sync.log` in the script directory.

| Event | Meaning |
|---|---|
| 9001 Information | a new certificate was installed |
| 9002 Warning | fewer than 21 days left and the published copy has not been renewed — check certbot on the VPS |
| 9003 Error | the run failed; the binding was left alone |

Event 9002 is the one that matters. It fires three weeks before anything
breaks, which is enough time for someone who has never seen this system to read
this file and work out what to do.

The sync worker in PathQuote also logs the certificate expiry it observes on
each run, so the warning arrives through two independent paths.

## Checking by hand

```powershell
# what is bound right now
netsh http show sslcert | Select-String "Hostname:port|IP:port|Certificate Hash"
Get-ChildItem Cert:\LocalMachine\My | Select-Object Subject, NotAfter, Thumbprint
```

```bash
# what the world sees
echo | openssl s_client -connect actapi.pathfindercut.com:443 \
  -servername actapi.pathfindercut.com 2>/dev/null |
  openssl x509 -noout -subject -dates -fingerprint -sha1
```
