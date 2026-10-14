# The mail slot of Screen Coach.
# The running chat starts this file as a BACKGROUND command. It waits for the next question
# from the board, prints it and ends. The end of the command wakes the chat.
#
#   -After N     only a question with a number above N counts (the last one the chat answered).
#                Left out: every question that exists now is old news (the value of last-id.txt).
#   -Chat "..."  the name of the chat that waits. The board shows it next to its light.
#   -Data "..."  the coach's own folder (the same one coach-on.ps1 got).
#
# THE LINK: while this file waits, it holds the slot. It writes slot\owner.json (the chat's name)
# and touches slot\beat every second, so the board can show a green light.
# One chat holds the slot at a time: when another chat arms the slot, this wait ends with COACH MOVED.
# It also ends when the board is closed (inbox\STOP), and after -MaxMinutes with a line that says so.

param([int]$After = -1, [string]$Chat = 'a chat', [int]$MaxMinutes = 240, [string]$Data = '')

$ErrorActionPreference = 'Stop'
if (-not $Data) { $Data = Join-Path $env:APPDATA 'screen-coach' }
$Data  = [System.IO.Path]::GetFullPath($Data)
$Chat  = ($Chat -replace '["''`$]', '').Trim()
if (-not $Chat) { $Chat = 'a chat' }
$inbox = Join-Path $Data 'inbox'
$slot  = Join-Path $Data 'slot'
$stop  = Join-Path $inbox 'STOP'
$owner = Join-Path $slot 'owner.json'
$beat  = Join-Path $slot 'beat'
$utf8  = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force -Path $inbox, $slot | Out-Null

if ($After -lt 0) {
    $After = 0
    $last = Join-Path $Data 'last-id.txt'
    if (Test-Path -LiteralPath $last) { $After = [int]([System.IO.File]::ReadAllText($last).Trim()) }
}

function Read-Owner {
    try { return [System.IO.File]::ReadAllText($owner, $utf8) | ConvertFrom-Json } catch { return $null }
}

# Take the slot for this chat.
$me  = [ordered]@{ chat = $Chat; pid = $PID; after = $After; armed = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
$tmp = "$owner.$PID.tmp"
[System.IO.File]::WriteAllText($tmp, $me, $utf8)
Move-Item -LiteralPath $tmp -Destination $owner -Force

$until = (Get-Date).AddMinutes($MaxMinutes)
$tick  = 0
while ((Get-Date) -lt $until) {
    if ($tick % 5 -eq 0) {
        # about once a second: does this wait still hold the slot?
        $o = Read-Owner
        if ($o -and [int]$o.pid -ne $PID) {
            if ([string]$o.chat -ne $Chat) {
                'COACH MOVED to the chat "' + $o.chat + '". This chat no longer holds the coach. Do not arm the slot again.'
            } else {
                'COACH: a newer wait of this same chat holds the slot. Do nothing.'
            }
            exit 0
        }
        [System.IO.File]::WriteAllText($beat, (Get-Date).ToString('o'), $utf8)
    }
    $tick++
    $next = Get-ChildItem -LiteralPath $inbox -Filter 'q-*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match '^q-(\d+)$' -and [int]$Matches[1] -gt $After } |
        Sort-Object Name | Select-Object -First 1
    if ($next) {
        $q = [System.IO.File]::ReadAllText($next.FullName, $utf8) | ConvertFrom-Json
        # the board shows "The chat has your question" when this flag is there
        [System.IO.File]::WriteAllText(($next.FullName -replace '\.json$', '.got'), '', $utf8)
        'COACH QUESTION ' + $q.id
        'text: ' + $q.text
        'picture: ' + $q.shot
        'size: ' + $q.picture.width + 'x' + $q.picture.height
        'sent: ' + $q.sent
        exit 0
    }
    if (Test-Path -LiteralPath $stop) {
        'COACH CLOSED (the board was closed at ' + (Get-Content -LiteralPath $stop -Raw) + ')'
        exit 0
    }
    Start-Sleep -Milliseconds 200
}
'COACH WAIT ENDED after ' + $MaxMinutes + ' minutes with no question. Arm the slot again with -After ' + $After + ' and say nothing in the chat.'
