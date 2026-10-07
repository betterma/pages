#Requires -Version 5.1
<#
.SYNOPSIS
  One-click git push: try direct then proxy; auto rebase if remote is ahead.

.EXAMPLE
  .\push.ps1
  .\push.ps1 -Proxy http://127.0.0.1:7897
  .\push.ps1 -DirectFirst:$false
#>
param(
  [string]$Remote = "origin",
  [string]$Proxy = "",
  [switch]$DirectFirst = $true,
  [switch]$NoRebase
)

$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

function Get-DefaultProxyUrl {
  if ($Proxy) { return $Proxy.TrimEnd("/") }
  foreach ($key in @("https.proxy", "http.proxy")) {
    $v = ""
    try { $v = ((& git config --get $key) 2>$null | Out-String).Trim() } catch { $v = "" }
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

function Clear-ProxyEnv {
  foreach ($key in @(
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
      "http_proxy", "https_proxy", "all_proxy"
    )) {
    Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
  }
}

function Set-ProxyEnv([string]$url) {
  Clear-ProxyEnv
  $env:HTTP_PROXY = $url
  $env:HTTPS_PROXY = $url
  $env:http_proxy = $url
  $env:https_proxy = $url
  $env:ALL_PROXY = $url
  $env:all_proxy = $url
}

function Save-ProxyEnv {
  $keys = @(
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy"
  )
  $map = @{}
  foreach ($k in $keys) { $map[$k] = [Environment]::GetEnvironmentVariable($k) }
  return $map
}

function Restore-ProxyEnv($map) {
  foreach ($k in $map.Keys) {
    if ($null -eq $map[$k] -or $map[$k] -eq "") {
      Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue
    }
    else {
      Set-Item -LiteralPath "Env:$k" -Value $map[$k]
    }
  }
}

function Invoke-GitMode {
  param(
    [Parameter(Mandatory)][ValidateSet("direct", "proxy")][string]$Mode,
    [Parameter(Mandatory)][string[]]$GitArgs,
    [string]$ProxyUrl
  )
  $prev = Save-ProxyEnv
  try {
    if ($Mode -eq "direct") {
      Clear-ProxyEnv
      $gitArgs = @("-c", "http.proxy=", "-c", "https.proxy=") + $GitArgs
    }
    else {
      if (-not $ProxyUrl) { throw "proxy url empty" }
      Set-ProxyEnv $ProxyUrl
      $gitArgs = @(
        "-c", "http.proxy=$ProxyUrl",
        "-c", "https.proxy=$ProxyUrl"
      ) + $GitArgs
    }
    Write-Host (">> [{0}] git {1}" -f $Mode, ($GitArgs -join " ")) -ForegroundColor DarkCyan
    & git @gitArgs
    return ($LASTEXITCODE -eq 0)
  }
  finally {
    Restore-ProxyEnv $prev
  }
}

function Get-BranchBehind {
  param([string]$Mode, [string]$ProxyUrl, [string]$Branch)
  $null = Invoke-GitMode -Mode $Mode -ProxyUrl $ProxyUrl -GitArgs @("fetch", $Remote)
  $counts = ""
  try {
    $counts = ((& git rev-list --left-right --count "HEAD...$Remote/$Branch") 2>$null | Out-String).Trim()
  }
  catch { $counts = "" }
  if (-not $counts) { return -1 }
  $parts = ($counts -split "\s+")
  if ($parts.Count -lt 2) { return -1 }
  return [int]$parts[1]
}

$proxyUrl = Get-DefaultProxyUrl
$modes = if ($DirectFirst) { @("direct", "proxy") } else { @("proxy", "direct") }

Write-Host ""
Write-Host "=== one-click push ===" -ForegroundColor Green
Write-Host ("repo   : {0}" -f $PSScriptRoot)
Write-Host ("remote : {0}" -f $Remote)
Write-Host ("proxy  : {0}" -f $proxyUrl)
Write-Host ("order  : {0}" -f ($modes -join " -> "))
Write-Host ""

& git rev-parse --is-inside-work-tree 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: not a git repo" -ForegroundColor Red
  exit 1
}

$branch = ((& git rev-parse --abbrev-ref HEAD) | Out-String).Trim()
Write-Host ("branch : {0}" -f $branch)
& git status -sb
Write-Host ""

$usedMode = $null
$ok = $false

foreach ($mode in $modes) {
  if (Invoke-GitMode -Mode $mode -ProxyUrl $proxyUrl -GitArgs @("push", "-u", $Remote, "HEAD")) {
    $ok = $true
    $usedMode = $mode
    break
  }

  $behind = Get-BranchBehind -Mode $mode -ProxyUrl $proxyUrl -Branch $branch
  if ($behind -gt 0 -and -not $NoRebase) {
    Write-Host ("remote ahead by {0} - pull --rebase then retry" -f $behind) -ForegroundColor Yellow
    $dirty = ((& git status --porcelain) 2>$null | Out-String).Trim()
    $didStash = $false
    if ($dirty) {
      Write-Host "local changes detected - stash before rebase" -ForegroundColor Yellow
      & git stash push -u -m "push.ps1 auto-stash before rebase"
      if ($LASTEXITCODE -eq 0) { $didStash = $true }
    }
    $pulled = Invoke-GitMode -Mode $mode -ProxyUrl $proxyUrl -GitArgs @(
      "pull", "--rebase", $Remote, $branch
    )
    if ($didStash) {
      Write-Host "restore stash" -ForegroundColor DarkCyan
      & git stash pop
      if ($LASTEXITCODE -ne 0) {
        Write-Host "WARN: stash pop had conflicts - resolve manually" -ForegroundColor Yellow
      }
    }
    if ($pulled) {
      if (Invoke-GitMode -Mode $mode -ProxyUrl $proxyUrl -GitArgs @("push", "-u", $Remote, "HEAD")) {
        $ok = $true
        $usedMode = $mode
        break
      }
    }
    else {
      Write-Host ("rebase failed under [{0}] - try next network mode" -f $mode) -ForegroundColor Yellow
    }
  }
  else {
    Write-Host ("[{0}] push failed, trying next..." -f $mode) -ForegroundColor Yellow
  }
}

Write-Host ""
if ($ok) {
  Write-Host ("OK - pushed via [{0}]" -f $usedMode) -ForegroundColor Green
  & git status -sb
  & git log -1 --oneline
  exit 0
}

Write-Host "FAILED: direct and proxy both failed." -ForegroundColor Red
Write-Host "Tips:" -ForegroundColor Yellow
Write-Host '  .\push.ps1 -DirectFirst:$false'
Write-Host '  .\push.ps1 -Proxy http://127.0.0.1:7897'
Write-Host '  On rebase conflict: fix, git rebase --continue, then run again'
exit 1
