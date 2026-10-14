# "coach on": the first step when the user says those words in a chat.
# It starts the board if it is not up, and prints the exact command for the next step.
# It does NOT wait for a question: after it, the chat arms the slot with coach.ps1 as a BACKGROUND command.
#
#   -Chat "..."  the name of this chat, as the board shows it.
#   -Data "..."  the coach's own folder (the plugin's data folder): the board app, the questions and the screenshots.
#
# The first start installs the board app (Electron, pinned in app\package-lock.json) into <Data>\engine with npm.
# That needs Node.js and takes a few minutes. Later starts take a few seconds.

param([string]$Chat = 'a chat', [string]$Data = '', [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app  = Join-Path $root 'app'
if (-not $Data) { $Data = Join-Path $env:APPDATA 'screen-coach' }
$Data = [System.IO.Path]::GetFullPath($Data)
$Chat = ($Chat -replace '["''`$]', '').Trim()
if (-not $Chat) { $Chat = 'a chat' }
New-Item -ItemType Directory -Force -Path $Data | Out-Null

$slot    = Join-Path $Data 'slot'
$appJson = Join-Path $slot 'app.json'
$stop    = Join-Path (Join-Path $Data 'inbox') 'STOP'
$owner   = Join-Path $slot 'owner.json'
$appLog  = Join-Path $Data 'app.log'
$engine  = Join-Path $Data 'engine'
$exe     = Join-Path $engine 'node_modules\electron\dist\electron.exe'
$utf8    = New-Object System.Text.UTF8Encoding $false

function Test-BoardUp {
    # the board writes slot\app.json with its process number at a real start, and removes it when it closes
    if (Test-Path -LiteralPath $stop) { return $false }
    try { $a = [System.IO.File]::ReadAllText($appJson, $utf8) | ConvertFrom-Json } catch { return $false }
    $p = Get-Process -Id ([int]$a.pid) -ErrorAction SilentlyContinue
    return [bool]($p -and $p.ProcessName -eq 'electron')
}

function Test-EngineReady {
    # ready = Electron is there AND it was installed from the same lock file as this version of the plugin
    if (-not (Test-Path -LiteralPath $exe)) { return $false }
    $mine = Join-Path $engine 'package-lock.json'
    if (-not (Test-Path -LiteralPath $mine)) { return $false }
    return (Get-FileHash -LiteralPath $mine).Hash -eq (Get-FileHash -LiteralPath (Join-Path $app 'package-lock.json')).Hash
}

function Out-Tool([string]$Label) {
    # stderr lines of a tool arrive as error records: print their text, skip the empty ones
    process {
        $s = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        if ($s.Trim() -and $s -ne 'System.Management.Automation.RemoteException') { '  ' + $Label + ': ' + $s }
    }
}

function Install-Engine {
    $npm  = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $npm -or -not $node) {
        'COACH ON FAILED: Node.js is not installed. The first start needs it to install the board app.'
        'Ask the user to install Node.js (the LTS version) from https://nodejs.org, open a new chat, and say "coach on" again.'
        exit 1
    }
    New-Item -ItemType Directory -Force -Path $engine | Out-Null
    Copy-Item -LiteralPath (Join-Path $app 'package.json'), (Join-Path $app 'package-lock.json') -Destination $engine -Force
    'Installing the board app (Electron, about 120 MB to download, about 380 MB on disk). This happens once.'
    # Step 1: npm installs the exact packages of the lock file. Step 2: Electron's own installer downloads
    # the Electron program and checks it against the checksums that ship in the package.
    # Its download cache stays inside the engine folder and is removed after.
    $cache = Join-Path $engine 'download-cache'
    $env:electron_config_cache = $cache
    Push-Location -LiteralPath $engine
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # npm and node write notes to stderr: they must not stop this script
    try {
        & $npm.Source ci --no-audit --no-fund --loglevel=error 2>&1 | Out-Tool 'npm'
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            & $node.Source (Join-Path $engine 'node_modules\electron\install.js') 2>&1 | Out-Tool 'electron'
            $code = $LASTEXITCODE
        }
    } finally {
        $ErrorActionPreference = $old
        Pop-Location
        Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
        'COACH ON FAILED: the board app did not install (exit code ' + $code + '). The lines above say why.'
        exit 1
    }
    'The board app is installed.'
}

$was = Test-BoardUp
$before = ''
try { $before = [string](([System.IO.File]::ReadAllText($owner, $utf8) | ConvertFrom-Json).chat) } catch { }

if (-not $was -and -not $NoStart) {
    if (-not (Test-EngineReady)) { Install-Engine }
    # Claude's desktop app is Electron too: with this switch set, the board would start as plain Node
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $exe -ArgumentList @("`"$app`"", "`"--data=$Data`"")
    $until = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $until -and -not (Test-BoardUp)) { Start-Sleep -Milliseconds 250 }
}

$up = Test-BoardUp
$last = 0
$lastFile = Join-Path $Data 'last-id.txt'
if (Test-Path -LiteralPath $lastFile) { $last = [int]([System.IO.File]::ReadAllText($lastFile).Trim()) }

if (-not $up) {
    'COACH ON FAILED: the board is not up. Read the last lines of ' + $appLog
    exit 1
}
'COACH ON  board=' + $(if ($was) { 'was up already' } else { 'started now' }) + '  last question=' + $last
if ($was -and $before -and $before -ne $Chat) { 'The coach moves here from the chat "' + $before + '" when the slot is armed.' }
'NEXT, as a BACKGROUND command:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'coach.ps1') + '" -After ' + $last + ' -Chat "' + $Chat + '" -Data "' + $Data + '"'
