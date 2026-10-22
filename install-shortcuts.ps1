# Points your Stremio shortcuts (Start Menu and taskbar pin) at launcher.js,
# so the For You addon starts with Stremio and stops when it closes.
# The original shortcuts are backed up to .\shortcut-backup.
#
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1         # install
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -Undo   # restore originals
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$backupDir = Join-Path $projectDir 'shortcut-backup'
$stremioExe = Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio-shell-ng.exe'
$node = (Get-Command node).Source
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'

$shortcuts = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Stremio.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Stremio.lnk')
)
$shell = New-Object -ComObject WScript.Shell

foreach ($path in $shortcuts) {
  if (-not (Test-Path $path)) { Write-Host "Skipped (not found): $path"; continue }
  $backup = Join-Path $backupDir ((Split-Path (Split-Path $path) -Leaf) + ' - ' + (Split-Path $path -Leaf))

  if ($Undo) {
    if (Test-Path $backup) { Copy-Item $backup $path -Force; Write-Host "Restored: $path" }
    else { Write-Host "No backup for: $path" }
    continue
  }

  New-Item -ItemType Directory -Force $backupDir | Out-Null
  $link = $shell.CreateShortcut($path)
  # Back up only the original Stremio shortcut, never one we already changed.
  if ($link.TargetPath -ieq $stremioExe -and -not (Test-Path $backup)) { Copy-Item $path $backup }

  # conhost --headless runs node without a console window.
  $link.TargetPath = $conhost
  $link.Arguments = "--headless `"$node`" `"$(Join-Path $projectDir 'launcher.js')`""
  $link.WorkingDirectory = $projectDir
  $link.IconLocation = "$stremioExe,0"
  $link.Description = 'Stremio (with the For You addon)'
  $link.Save()
  Write-Host "Updated: $path"
}
