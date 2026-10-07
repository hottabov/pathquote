<#
.SYNOPSIS
    Keep the actapi.pathfindercut.com certificate on the Act! server current.

.DESCRIPTION
    The Act! server is reachable only from the office LAN, so nobody outside
    can renew its certificate by hand. Left manual, the integration dies the
    first time the one person who knows about it is on holiday.

    Certbot on the VPS renews every 60 days and publishes a PFX. This task
    runs weekly on the Act! server, fetches that PFX over an outbound HTTPS
    connection, and installs it only when the thumbprint has actually changed.
    Nothing listens, nothing is installed, no inbound firewall rule exists.

    The catch-all 0.0.0.0:443 binding, which carries the provider's wildcard
    and serves Act! sync, is never touched. Only the SNI binding for
    actapi.pathfindercut.com is rebound.

.NOTES
    Runs as SYSTEM. Needs the WebAdministration module, which IIS provides.
    Configuration lives in the JSON file named by -ConfigPath, readable only
    by SYSTEM and Administrators because it holds the bearer token and the
    PFX password.

    Install:
        $d = "C:\Scripts\act-cert"
        New-Item -ItemType Directory -Force -Path $d
        # copy this script and config.json into $d, then:
        icacls $d /inheritance:r /grant "SYSTEM:(OI)(CI)F" /grant "Administrators:(OI)(CI)F"

        $a = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-NoProfile -ExecutionPolicy Bypass -File $d\Sync-ActApiCertificate.ps1"
        $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
        $p = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName "Act API certificate sync" -Action $a -Trigger $t -Principal $p

    Verify by hand at any time:
        powershell -File C:\Scripts\act-cert\Sync-ActApiCertificate.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [string]$LogPath    = "$PSScriptRoot\sync.log"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log {
    param([string]$Level, [string]$Message)
    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Output $line
    try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { }
}

function Write-Event {
    # Surfaces failures where monitoring can see them, not only in a text file
    # nobody opens.
    param([string]$Message, [string]$Type = 'Information', [int]$Id = 9001)
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists('ActApiCertSync')) {
            New-EventLog -LogName Application -Source 'ActApiCertSync'
        }
        Write-EventLog -LogName Application -Source 'ActApiCertSync' `
            -EventId $Id -EntryType $Type -Message $Message
    } catch { }
}

trap {
    Write-Log 'ERROR' $_.Exception.Message
    Write-Event "Certificate sync failed: $($_.Exception.Message)" 'Error' 9003
    exit 1
}

# --- configuration -------------------------------------------------------

if (-not (Test-Path $ConfigPath)) {
    throw "missing configuration file $ConfigPath"
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$present = @($cfg.PSObject.Properties.Name)
foreach ($key in 'Url', 'Token', 'PfxPassword', 'HostName', 'SiteName') {
    if (($present -notcontains $key) -or -not $cfg.$key) {
        throw "configuration is missing '$key'"
    }
}

$binding = "IIS:\SslBindings\!443!$($cfg.HostName)"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Import-Module WebAdministration -ErrorAction Stop

# --- what is installed now ----------------------------------------------

$currentThumbprint = $null
if (Test-Path $binding) {
    $currentThumbprint = (Get-Item $binding).Thumbprint
}
Write-Log 'INFO' "current binding: $(if ($currentThumbprint) { $currentThumbprint } else { 'none' })"

# --- fetch ---------------------------------------------------------------

$temp = Join-Path $env:TEMP ("actapi-{0}.pfx" -f ([guid]::NewGuid().ToString('N')))
try {
    Invoke-WebRequest -Uri $cfg.Url -OutFile $temp -UseBasicParsing -TimeoutSec 60 `
        -Headers @{ Authorization = "Bearer $($cfg.Token)" }
    Write-Log 'INFO' "downloaded $([math]::Round((Get-Item $temp).Length / 1KB, 1)) KB"

    $securePassword = ConvertTo-SecureString $cfg.PfxPassword -AsPlainText -Force

    # Read the thumbprint without importing, so an unchanged certificate
    # never touches the store.
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword))
    $probe = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
    $probe.Import($temp, $plain, 'DefaultKeySet')
    $newThumbprint = $probe.Thumbprint
    $notAfter = $probe.NotAfter
    $probe.Dispose()
    Write-Log 'INFO' "downloaded certificate $newThumbprint, expires $($notAfter.ToString('yyyy-MM-dd'))"

    if ($notAfter -lt (Get-Date)) {
        throw "downloaded certificate expired on $($notAfter.ToString('yyyy-MM-dd')) -- refusing to install"
    }

    if ($newThumbprint -eq $currentThumbprint) {
        $daysLeft = [int]($notAfter - (Get-Date)).TotalDays
        Write-Log 'INFO' "unchanged, $daysLeft days remaining -- nothing to do"
        if ($daysLeft -lt 21) {
            Write-Event "actapi certificate expires in $daysLeft days and the published copy has not been renewed. Check certbot on the VPS." 'Warning' 9002
        }
        exit 0
    }

    # --- install ---------------------------------------------------------

    if (-not $PSCmdlet.ShouldProcess($cfg.HostName, "install certificate $newThumbprint")) {
        Write-Log 'INFO' 'WhatIf -- stopping before any change'
        exit 0
    }

    $imported = Import-PfxCertificate -FilePath $temp `
        -CertStoreLocation Cert:\LocalMachine\My -Password $securePassword
    Write-Log 'INFO' "imported $($imported.Thumbprint)"

    # The web binding usually already exists; only the certificate mapping
    # needs replacing.
    $web = Get-WebBinding -Name $cfg.SiteName -Protocol https -Port 443 |
           Where-Object { $_.bindingInformation -like "*:443:$($cfg.HostName)" }
    if (-not $web) {
        New-WebBinding -Name $cfg.SiteName -Protocol https -Port 443 `
            -HostHeader $cfg.HostName -SslFlags 1
        Write-Log 'INFO' 'created the web binding'
    }

    if (Test-Path $binding) { Remove-Item $binding -Force }
    Get-Item "Cert:\LocalMachine\My\$($imported.Thumbprint)" |
        New-Item -Path $binding -SSLFlags 1 | Out-Null
    Write-Log 'INFO' "rebound $($cfg.HostName) to $($imported.Thumbprint)"

    # Drop the superseded certificate, but only ours and only if nothing
    # else is bound to it.
    if ($currentThumbprint -and $currentThumbprint -ne $imported.Thumbprint) {
        $stillUsed = @(Get-ChildItem IIS:\SslBindings |
                       Where-Object { $_.PSObject.Properties.Name -contains 'Thumbprint' -and
                                      $_.Thumbprint -eq $currentThumbprint })
        if ($stillUsed.Count -eq 0) {
            Remove-Item "Cert:\LocalMachine\My\$currentThumbprint" -Force -ErrorAction SilentlyContinue
            Write-Log 'INFO' "removed the superseded certificate $currentThumbprint"
        }
    }

    Write-Event "Installed actapi certificate $($imported.Thumbprint), expires $($notAfter.ToString('yyyy-MM-dd'))."
    Write-Log 'INFO' 'done'
}
finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
}
