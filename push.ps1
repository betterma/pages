#Requires -Version 5.1
<#
.SYNOPSIS
  One-click git push: probe network, wait for a window, fall back to proxy,
  auto rebase when the remote is ahead.

.DESCRIPTION
  Changes vs the original script:
  - Never touches proxy environment variables, so no Remove-Item Env:* and
    nothing a safe-delete guard can block. Proxy is passed per command via
    `git -c http.proxy=...`.
  - Probes github.com with curl before each attempt and waits for a working
    window instead of burning 21s on every doomed connect (the link here is
    intermittent).
  - Judges results by exit code only, so git's stderr no longer shows up as
    PowerShell NativeCommandError noise.

.EXAMPLE
  .\push.ps1
  .\push.ps1 -Proxy http://127.0.0.1:7897
  .\push.ps1 -DirectFirst:$false
  .\push.ps1 -WaitSeconds 600 -ProbeInterval 10
#>
param(
  [string]$Remote = "origin",
  [string]$Proxy = "",
  [switch]$DirectFirst = $true,
  [switch]$NoRebase,
  [int]$WaitSeconds = 180,
  [int]$ProbeInterval = 5
)

$ErrorActionPreference = "SilentlyContinue"
Set-Location -LiteralPath $PSScriptRoot

function Get-DefaultProxyUrl {
  if ($Proxy) { return $Proxy.TrimEnd("/") }
  foreach ($key in @("https.proxy", "http.proxy")) {
    $v = (((& git config --get $key) -join "")).Trim()
    if ($v) { return $v.TrimEnd("/") }
  }
  foreach ($key in @(
      "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"
    )) {
    $v = [Environment]::GetEnvironmentVariable($key)
    if ($v) { return $v.Trim().TrimEnd("/") }
  }
  return "http://127.0.0.1:7897"
}

function Get-GitBaseArgs([string]$Mode, [string]$ProxyUrl) {
  if ($Mode -eq "proxy") {
    return @("-c", "http.proxy=$ProxyUrl", "-c", "https.proxy=$ProxyUrl")
  }
  return @("-c", "http.proxy=", "-c", "https.proxy=")
}

function Test-Net([string]$Mode, [string]$ProxyUrl) {
  $curlArgs = @("-4", "-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "8", "https://github.com")
  if ($Mode -eq "proxy") {
    $curlArgs = @("-x", $ProxyUrl) + $curlArgs
  }
  $code = (((& curl.exe @curlArgs) -join "")).Trim()
  return ($code -eq "200" -or $code -eq "301" -or $code -eq "302")
}

function Wait-Net([string]$Mode, [string]$ProxyUrl) {
  if ($WaitSeconds -le 0) { return (Test-Net $Mode $ProxyUrl) }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $n = 0
  while ((Get-Date) -lt $deadline) {
    $n++
    if (Test-Net $Mode $ProxyUrl) {
      Write-Host ("  probe #{0} [{1}] OK" -f $n, $Mode) -ForegroundColor Green
      return $true
    }
    Write-Host ("  probe #{0} [{1}] no route, retry in {2}s" -f $n, $Mode, $ProbeInterval) -ForegroundColor DarkGray
    Start-Sleep -Seconds $ProbeInterval
  }
  return $false
}

function Invoke-GitPush([string]$Mode, [string]$ProxyUrl, [string]$Branch) {
  $base = Get-GitBaseArgs $Mode $ProxyUrl
  for ($round = 1; $round -le 3; $round++) {
    Write-Host (">> [{0}] git push ({1}/3)" -f $Mode, $round) -ForegroundColor DarkCyan
    & git @base push -u $Remote HEAD
    if ($LASTEXITCODE -eq 0) { return $true }

    # Network dropped mid-flight: give up on this mode, caller may try the next.
    if (-not (Test-Net $Mode $ProxyUrl)) {
      Write-Host "  network unavailable - abort this mode" -ForegroundColor Yellow
      return $false
    }
    if ($NoRebase) { return $false }

    $dirty = (((& git status --porcelain) -join "")).Trim()
    $didStash = $false
    if ($dirty) {
      Write-Host "  local changes detected - stash before rebase" -ForegroundColor Yellow
      & git stash push -u -m "push.ps1 auto-stash before rebase" | Out-Null
      if ($LASTEXITCODE -eq 0) { $didStash = $true }
    }

    Write-Host (">> [{0}] git pull --rebase {1} {2}" -f $Mode, $Remote, $Branch) -ForegroundColor DarkCyan
    & git @base pull --rebase $Remote $Branch
    $pullOk = ($LASTEXITCODE -eq 0)

    if ($didStash) {
      Write-Host "  restore stash" -ForegroundColor DarkCyan
      & git stash pop | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARN: stash pop had conflicts - resolve manually" -ForegroundColor Yellow
      }
    }
    if (-not $pullOk) {
      Write-Host "  rebase failed - stop this mode" -ForegroundColor Yellow
      return $false
    }
  }
  return $false
}

$proxyUrl = Get-DefaultProxyUrl
$modes = if ($DirectFirst) { @("direct", "proxy") } else { @("proxy", "direct") }

Write-Host ""
Write-Host "=== one-click push ===" -ForegroundColor Green
Write-Host ("repo    : {0}" -f $PSScriptRoot)
Write-Host ("remote  : {0}" -f $Remote)
Write-Host ("proxy   : {0}" -f $proxyUrl)
Write-Host ("order   : {0}" -f ($modes -join " -> "))
Write-Host ("network : probe then wait up to {0}s per mode" -f $WaitSeconds)
Write-Host ""

& git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: not a git repo" -ForegroundColor Red
  exit 1
}

$branch = ((((& git rev-parse --abbrev-ref HEAD) -join "")).Trim())
Write-Host ("branch  : {0}" -f $branch)
& git status -sb
Write-Host ""

$ok = $false
$usedMode = $null

foreach ($mode in $modes) {
  if (-not (Wait-Net $mode $proxyUrl)) {
    Write-Host ("[{0}] no network window within {1}s - try next mode" -f $mode, $WaitSeconds) -ForegroundColor Yellow
    continue
  }
  if (Invoke-GitPush $mode $proxyUrl $branch) {
    $ok = $true
    $usedMode = $mode
    break
  }
  Write-Host ("[{0}] push did not succeed - try next mode" -f $mode) -ForegroundColor Yellow
}

Write-Host ""
if ($ok) {
  Write-Host ("OK - pushed via [{0}]" -f $usedMode) -ForegroundColor Green
  & git status -sb
  & git log -1 --oneline
  exit 0
}

Write-Host "FAILED: no working network window, or push rejected." -ForegroundColor Red
Write-Host "Tips:" -ForegroundColor Yellow
Write-Host '  .\push.cmd -WaitSeconds 600             # wait longer for a window'
Write-Host '  .\push.cmd -Proxy http://127.0.0.1:7890 # different proxy port'
Write-Host '  .\push.cmd -DirectFirst:$false          # proxy first'
Write-Host '  On rebase conflict: fix, git rebase --continue, then run again'
exit 1
