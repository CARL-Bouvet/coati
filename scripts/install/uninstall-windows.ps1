# Reverses scripts/install/install-windows.ps1. Not verified on real
# hardware (no Windows available in this environment) - logic follows the
# spec; CI syntax-checks this file with `pwsh -NoProfile`.
#
#   scripts/install/uninstall-windows.ps1 [options]
[CmdletBinding()]
param(
    [string]$Prefix = $env:LOCALAPPDATA,

    [switch]$NoService,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$HostName = "com.getcoati.broker"
$TaskName = "CoatiBroker"

$AppDir = Join-Path $Prefix "Coati"
$BinDest = Join-Path $AppDir "coati-broker.exe"
$NativeHostDir = Join-Path $AppDir "native-host"
$ChromiumManifestDest = Join-Path $NativeHostDir "com.getcoati.broker.chromium.json"
$FirefoxManifestDest = Join-Path $NativeHostDir "com.getcoati.broker.firefox.json"

function Remove-IfExists {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ($DryRun) {
        Write-Host "[dry-run] Remove-Item $Path"
        return
    }
    Remove-Item -LiteralPath $Path -Force
    Write-Host "Removed: $Path"
}

if ($NoService) {
    if ($DryRun) {
        Write-Host "[dry-run] tâche planifiée ignorée (-NoService)"
    }
} else {
    if ($DryRun) {
        Write-Host "[dry-run] Unregister-ScheduledTask $TaskName"
    } else {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Tâche planifiée supprimée : $TaskName"
    }
}

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
)

foreach ($key in $RegistryKeys) {
    if ($DryRun) {
        Write-Host "[dry-run] reg delete $key /f"
        continue
    }
    if (Test-Path -LiteralPath $key) {
        Remove-Item -LiteralPath $key -Force
        Write-Host "Registre supprimé : $key"
    }
}

Remove-IfExists $ChromiumManifestDest
Remove-IfExists $FirefoxManifestDest
# A running broker locks its .exe on Windows: stop it (only processes started
# from this exact binary), then retry the removal while the handle is released.
if (-not $DryRun -and (Test-Path -LiteralPath $BinDest)) {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -ieq $BinDest) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $BinDest); $i++) {
        try { Remove-Item -LiteralPath $BinDest -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
    }
    if (Test-Path -LiteralPath $BinDest) { throw "Impossible de supprimer $BinDest (fichier encore utilisé)." }
    Write-Host "Supprimé : $BinDest"
}
Remove-IfExists $BinDest

Write-Host ""
Write-Host "Désinstallation terminée."
