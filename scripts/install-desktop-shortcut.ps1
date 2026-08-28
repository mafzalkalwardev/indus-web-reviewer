# Install Desktop + Start Menu shortcuts for Indus Web Reviewer
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "launch\Start-Indus-Web-Reviewer.vbs"))) {
  $Root = (Get-Location).Path
}

$Launch = Join-Path $Root "launch"
$Electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
$Icon = if (Test-Path $Electron) { "$Electron,0" } else { "shell32.dll,24" }

$Desktop = [Environment]::GetFolderPath("Desktop")
$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Indus Web Reviewer"
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null

function New-IwrShortcut([string]$Dir, [string]$Name, [string]$Vbs, [string]$Desc) {
  $lnkPath = Join-Path $Dir "$Name.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $sc.Arguments = "`"$Vbs`""
  $sc.WorkingDirectory = $Root
  $sc.WindowStyle = 7
  $sc.Description = $Desc
  $sc.IconLocation = $Icon
  $sc.Save()
  Write-Host "[shortcut] $lnkPath"
}

$items = @(
  @{
    Name = "Indus Web Reviewer"
    Vbs  = (Join-Path $Launch "Start-Indus-Web-Reviewer.vbs")
    Desc = "Open Indus Web Reviewer dashboard"
  },
  @{
    Name = "Indus Web Reviewer (Start Worker)"
    Vbs  = (Join-Path $Launch "Start-Indus-With-Worker.vbs")
    Desc = "Open dashboard and auto-start the wait worker"
  }
)

foreach ($item in $items) {
  if (-not (Test-Path $item.Vbs)) { throw "Missing $($item.Vbs)" }
  New-IwrShortcut -Dir $Desktop -Name $item.Name -Vbs $item.Vbs -Desc $item.Desc
  New-IwrShortcut -Dir $StartMenu -Name $item.Name -Vbs $item.Vbs -Desc $item.Desc
}

Write-Host ""
Write-Host "Ready. Double-click on Desktop:"
Write-Host "  - Indus Web Reviewer"
Write-Host "  - Indus Web Reviewer (Start Worker)"
Write-Host "Desktop folder: $Desktop"
