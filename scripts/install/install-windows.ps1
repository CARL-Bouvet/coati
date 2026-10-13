# Installs a downloaded coati-broker.exe as both a per-user scheduled task
# and the Native Messaging host on Windows (docs/PROTOCOL.md
# "Native Messaging" - section "Windows"). Idempotent.
# Never requires an elevated ("Run as administrator") shell.
#
#   scripts/install/install-windows.ps1 -Binary <path-to-coati-broker.exe> [options]
#
# Options:
#   -Prefix <dir>   Use <dir> instead of $env:LOCALAPPDATA as the install
#                   root (tests, CI).
#   -NoService      Skip the scheduled task entirely (just the binary +
#                   Native Messaging manifests + registry keys).
#   -DryRun         Print what would be written/run, write/run nothing.
#
# Not verified on real hardware (no Windows available in this environment) -
# logic follows the spec; CI syntax-checks this file with `pwsh -NoProfile`.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Binary,

    [string]$Prefix = $env:LOCALAPPDATA,

    [switch]$NoService,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$HostName = "com.getcoati.broker"

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
    Write-Error "Binary not found: $Binary"
    exit 1
}

function Write-Step {
    param([string]$Message)
    if ($DryRun) {
        Write-Host "[dry-run] $Message"
    } else {
        Write-Host $Message
    }
}

function Ensure-Dir {
    param([string]$Dir)
    if (Test-Path -LiteralPath $Dir) { return }
    if ($DryRun) {
        Write-Host "[dry-run] mkdir $Dir"
        return
    }
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AppDir = Join-Path $Prefix "Coati"
$BinDest = Join-Path $AppDir "coati-broker.exe"
$NativeHostDir = Join-Path $AppDir "native-host"
$ChromiumManifestSrc = Join-Path $RepoRoot "packaging\native-host\com.getcoati.broker.chromium.json"
$FirefoxManifestSrc = Join-Path $RepoRoot "packaging\native-host\com.getcoati.broker.firefox.json"
$ChromiumManifestDest = Join-Path $NativeHostDir "com.getcoati.broker.chromium.json"
$FirefoxManifestDest = Join-Path $NativeHostDir "com.getcoati.broker.firefox.json"

Ensure-Dir $AppDir
if ($DryRun) {
    Write-Host "[dry-run] copy $Binary -> $BinDest"
} else {
    Copy-Item -LiteralPath $Binary -Destination $BinDest -Force
    Write-Host "Binary installed: $BinDest"
}

# Remove the "downloaded from the Internet" mark; without this SmartScreen may
# silently block the binary when the browser tries to launch it.
if ($DryRun) {
    Write-Host "[dry-run] Unblock-File $BinDest"
} else {
    Unblock-File -LiteralPath $BinDest -ErrorAction SilentlyContinue
}

# Path is JSON-encoded via ConvertTo-Json (the
# previous hand-rolled regex only doubled backslashes, leaving any `"` in
# $BinDest able to break out of the JSON string - unlikely for a path under
# LOCALAPPDATA, but not guaranteed for a custom -Prefix). ConvertTo-Json
# already produces a quoted JSON string (`"C:\\...\\coati-broker.exe"`), and
# the template's placeholder is itself already inside quotes
# (`"path": "@@HOST_PATH@@"`), so the quoted placeholder is what gets
# replaced - not just the bare token - to avoid doubling up quotes.
$JsonBinDest = ($BinDest | ConvertTo-Json)

Ensure-Dir $NativeHostDir
foreach ($pair in @(
    @{ Src = $ChromiumManifestSrc; Dest = $ChromiumManifestDest },
    @{ Src = $FirefoxManifestSrc; Dest = $FirefoxManifestDest }
)) {
    $content = Get-Content -LiteralPath $pair.Src -Raw
    $content = $content.Replace('"@@HOST_PATH@@"', $JsonBinDest)
    if ($DryRun) {
        Write-Host "[dry-run] write $($pair.Dest)"
    } else {
        Set-Content -LiteralPath $pair.Dest -Value $content -NoNewline -Encoding UTF8
        Write-Host "Manifest written: $($pair.Dest)"
    }
}

# HKCU registry keys - one per browser, default value = path to that
# family's manifest. Never HKLM: no admin required.
$RegistryKeys = @(
    @{ Browser = "Chrome"; Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"; Manifest = $ChromiumManifestDest },
    @{ Browser = "Chromium"; Key = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"; Manifest = $ChromiumManifestDest },
    @{ Browser = "Brave"; Key = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"; Manifest = $ChromiumManifestDest },
    @{ Browser = "Edge"; Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"; Manifest = $ChromiumManifestDest },
    @{ Browser = "Firefox"; Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"; Manifest = $FirefoxManifestDest }
)

foreach ($entry in $RegistryKeys) {
    if ($DryRun) {
        Write-Host "[dry-run] reg add $($entry.Key) /ve /t REG_SZ /d `"$($entry.Manifest)`" /f"
        continue
    }
    New-Item -Path $entry.Key -Force | Out-Null
    Set-ItemProperty -Path $entry.Key -Name "(default)" -Value $entry.Manifest
    Write-Host "Registry: $($entry.Key) -> $($entry.Manifest)"
}

# Private folder ACL - docs/PROTOCOL.md, "ACL explicite". The broker's data dir
# (broker-key.json, pairing.txt, etc.) and config dir are under the profile
# (%USERPROFILE%\.local\share\coati, %USERPROFILE%\.config\coati) and already
# inherit a default ACL that lets in only this user, SYSTEM and Administrators.
# In defense in depth, the installer additionally strips inheritance and grants
# full control to only those three principals (by SID - locale independent),
# then reads the ACL back to confirm no other principal remains. The broker
# itself never touches these ACLs (it only creates the dirs if missing).
# Skipped under -DryRun: icacls performs a real ACL change, never simulated.
$CurrentUserSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$SystemSid = "S-1-5-18"
$AdministratorsSid = "S-1-5-32-544"

function Set-PrivateDirAcl([string]$Dir) {
    if ($DryRun) {
        Write-Host "[dry-run] mkdir $Dir"
        Write-Host "[dry-run] icacls `"$Dir`" /inheritance:r /grant:r *${CurrentUserSid}:(OI)(CI)F /grant:r *${SystemSid}:(OI)(CI)F /grant:r *${AdministratorsSid}:(OI)(CI)F"
        return
    }
    Ensure-Dir $Dir

    & icacls.exe $Dir /inheritance:r `
        /grant:r "*${CurrentUserSid}:(OI)(CI)F" `
        /grant:r "*${SystemSid}:(OI)(CI)F" `
        /grant:r "*${AdministratorsSid}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "icacls failed (exit code $LASTEXITCODE) on $Dir"
        exit 1
    }

    $AllowedSids = @($CurrentUserSid, $SystemSid, $AdministratorsSid)
    $Acl = Get-Acl -LiteralPath $Dir
    $ActualSids = $Acl.Access | ForEach-Object {
        $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } | Sort-Object -Unique
    $Unexpected = $ActualSids | Where-Object { $AllowedSids -notcontains $_ }
    if ($Unexpected) {
        Write-Error "ACL of $Dir contains unexpected entries after icacls: $($Unexpected -join ', ')"
        exit 1
    }
    Write-Host "ACL verified: $Dir -> $($ActualSids -join ', ')"
}

Set-PrivateDirAcl (Join-Path $env:USERPROFILE ".local\share\coati")
Set-PrivateDirAcl (Join-Path $env:USERPROFILE ".config\coati")

if ($NoService) {
    Write-Step "scheduled task skipped (-NoService)"
} else {
    $TaskName = "CoatiBroker"
    if ($DryRun) {
        Write-Host "[dry-run] Register-ScheduledTask $TaskName -> $BinDest (logon trigger, current user)"
    } else {
        $Action = New-ScheduledTaskAction -Execute $BinDest
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Host "Scheduled task created and started: $TaskName"
    }
}

Write-Host ""
Write-Host "Installation complete."
